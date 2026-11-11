import type { EngineInterface } from 'claude-code'

import type { Usage, UsageLevels, UsageReport } from '../../types'

// What the agents and the stack cost the machine. Linux and macOS answer
// differently, so each has a probe of its own behind one interface: a command
// to run and a reader for what it prints. Everything after that is shared.

export type Platform = 'linux' | 'darwin'

export type Machine = {
  platform: Platform
  cores: number
  ramBytes: number
  /** Linux counts CPU time in ticks of this many a second. */
  clockTicks: number
  pageBytes: number
}

/** One process as a probe reads it. */
export type Proc = {
  pid: number
  cwd: string
  rssBytes: number
  /** CPU time used since the process began (Linux): a rate needs two readings. */
  cpuSeconds?: number
  /** CPU in use now, percent of one core (macOS says it outright). */
  cpuPercent?: number
}

type Probe = {
  /** Asked once: clock ticks, page size, cores, memory, one per line. */
  machine: readonly string[]
  /** Asked at every sample: working directories, `---`, then CPU and memory. */
  sample: readonly string[]
  readMachine: (lines: readonly string[]) => Omit<Machine, 'platform'>
  readSample: (cwds: string, stats: string, machine: Machine) => Proc[]
}

const sh = (script: string) => ['sh', '-c', script] as const
const int = (text: string | undefined) => Number.parseInt(text ?? '', 10)

function readLinux(cwds: string, stats: string, machine: Machine): Proc[] {
  const cwdOf = new Map<number, string>()
  for (const line of cwds.split('\n')) {
    const found = /^\/proc\/(\d+)\/cwd (.+)$/.exec(line)
    if (found) cwdOf.set(int(found[1]), found[2] ?? '')
  }
  const procs: Proc[] = []
  for (const line of stats.split('\n')) {
    // `pid (name) state ...`: the name may hold spaces and brackets.
    const close = line.lastIndexOf(') ')
    const pid = int(line)
    const cwd = cwdOf.get(pid)
    if (close < 0 || cwd === undefined) continue
    const fields = line.slice(close + 2).split(' ')
    const ticks = int(fields[11]) + int(fields[12])
    const pages = int(fields[21])
    if (Number.isNaN(ticks) || Number.isNaN(pages)) continue
    procs.push({ pid, cwd, cpuSeconds: ticks / machine.clockTicks, rssBytes: pages * machine.pageBytes })
  }

  return procs
}

function readDarwin(cwds: string, stats: string): Proc[] {
  // `lsof -Fpn`: a `p<pid>` line, then that process's `n<path>`.
  const cwdOf = new Map<number, string>()
  let pid = Number.NaN
  for (const line of cwds.split('\n')) {
    if (line.startsWith('p')) pid = int(line.slice(1))
    else if (line.startsWith('n') && !Number.isNaN(pid)) cwdOf.set(pid, line.slice(1))
  }
  const procs: Proc[] = []
  for (const line of stats.split('\n')) {
    const [id, cpu, rss] = line.trim().split(/\s+/)
    const cwd = cwdOf.get(int(id))
    const percent = Number.parseFloat((cpu ?? '').replace(',', '.'))
    if (cwd === undefined || Number.isNaN(percent) || Number.isNaN(int(rss))) continue
    procs.push({ pid: int(id), cwd, cpuPercent: percent, rssBytes: int(rss) * 1024 })
  }

  return procs
}

export const PROBES: Record<Platform, Probe> = {
  linux: {
    machine: sh("getconf CLK_TCK; getconf PAGESIZE; getconf _NPROCESSORS_ONLN; awk '/^MemTotal/{print $2}' /proc/meminfo"),
    sample: sh("find /proc -maxdepth 2 -name cwd -printf '%p %l\\n' 2>/dev/null; echo ---; cat /proc/[0-9]*/stat 2>/dev/null"),
    readMachine: ([ticks, page, cores, kib]) => ({
      clockTicks: int(ticks) || 100,
      pageBytes: int(page) || 4096,
      cores: int(cores) || 1,
      ramBytes: (int(kib) || 0) * 1024,
    }),
    readSample: readLinux,
  },
  darwin: {
    machine: sh('echo 100; pagesize; sysctl -n hw.ncpu; sysctl -n hw.memsize'),
    sample: sh('lsof -a -d cwd -Fpn 2>/dev/null; echo ---; ps -axo pid=,pcpu=,rss='),
    readMachine: ([ticks, page, cores, bytes]) => ({
      clockTicks: int(ticks) || 100,
      pageBytes: int(page) || 4096,
      cores: int(cores) || 1,
      ramBytes: int(bytes) || 0,
    }),
    readSample: readDarwin,
  },
}

export const platformOf = (uname: string): Platform | undefined =>
  /linux/i.test(uname) ? 'linux' : /darwin/i.test(uname) ? 'darwin' : undefined

export function parseSample(stdout: string, machine: Machine): Proc[] {
  const cut = stdout.indexOf('\n---\n')
  const [cwds, stats] = cut < 0 ? [stdout, ''] : [stdout.slice(0, cut), stdout.slice(cut + 5)]

  return PROBES[machine.platform].readSample(cwds, stats, machine)
}

/** The machine, asked once; undefined on a platform without a probe. */
export async function readMachine($: EngineInterface): Promise<Machine | undefined> {
  const uname = await $.process.run(['uname', '-s'], { timeoutMs: 5000 })
  const platform = platformOf(uname.stdout)
  if (platform === undefined) return undefined
  const ran = await $.process.run(PROBES[platform].machine, { timeoutMs: 5000 })
  const lines = ran.stdout.split('\n').map(l => l.trim())

  return { platform, ...PROBES[platform].readMachine(lines) }
}

export async function sampleProcs($: EngineInterface, machine: Machine): Promise<Proc[]> {
  const ran = await $.process.run(PROBES[machine.platform].sample, { timeoutMs: 8000 })

  return parseSample(ran.stdout, machine)
}

export type Tree = { id: string; path: string }

const inside = (cwd: string, path: string) => cwd === path || cwd.startsWith(`${path}/`)

/**
 * Each working tree's share: the processes whose working directory lies in
 * it, counted for the deepest tree that holds them, so a worktree nested in
 * the main checkout is not counted twice. `before` is the CPU time each
 * process had at the last sample, `elapsedMs` the time since.
 */
export function measure(
  procs: readonly Proc[],
  trees: readonly Tree[],
  before: Readonly<Record<number, number>> | null,
  elapsedMs: number,
): { usage: Record<string, Usage>; cpuSeconds: Record<number, number> } {
  const deepest = [...trees].sort((a, b) => b.path.length - a.path.length)
  const usage: Record<string, Usage> = {}
  for (const tree of trees) usage[tree.id] = { cpu: 0, ramBytes: 0 }
  const cpuSeconds: Record<number, number> = {}

  for (const proc of procs) {
    const owner = deepest.find(tree => inside(proc.cwd, tree.path))
    if (owner === undefined) continue
    const share = usage[owner.id]
    if (share === undefined) continue
    share.ramBytes += proc.rssBytes
    if (proc.cpuPercent !== undefined) share.cpu += proc.cpuPercent
    if (proc.cpuSeconds !== undefined) {
      cpuSeconds[proc.pid] = proc.cpuSeconds
      const was = before?.[proc.pid]
      // A process seen for the first time has no rate yet.
      if (was !== undefined && elapsedMs > 0) {
        share.cpu += Math.max(0, ((proc.cpuSeconds - was) / (elapsedMs / 1000)) * 100)
      }
    }
  }

  return { usage, cpuSeconds }
}

const UNITS: Record<string, number> = {
  b: 1, kb: 1e3, mb: 1e6, gb: 1e9, tb: 1e12, kib: 1024, mib: 1024 ** 2, gib: 1024 ** 3, tib: 1024 ** 4,
}

/** Reads `docker stats --no-stream --format '{{.Name}} {{.CPUPerc}} {{.MemUsage}}'`. */
export function parseDockerStats(stdout: string): Record<string, Usage> {
  const usage: Record<string, Usage> = {}
  for (const line of stdout.split('\n')) {
    const found = /^(\S+)\s+([\d.,]+)%\s+([\d.,]+)\s*([A-Za-z]+)/.exec(line.trim())
    if (!found) continue
    const [, name = '', cpu = '', amount = '', unit = ''] = found
    const scale = UNITS[unit.toLowerCase()]
    if (scale === undefined) continue
    usage[name] = { cpu: Number.parseFloat(cpu.replace(',', '.')), ramBytes: Number.parseFloat(amount.replace(',', '.')) * scale }
  }

  return usage
}

export async function sampleContainers(
  $: EngineInterface,
  containers: readonly string[],
): Promise<Record<string, Usage>> {
  const names = containers.filter(c => /^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(c))
  if (names.length === 0) return {}
  try {
    const ran = await $.process.run(
      ['docker', 'stats', '--no-stream', '--format', '{{.Name}} {{.CPUPerc}} {{.MemUsage}}', ...names],
      { timeoutMs: 15000 },
    )

    return parseDockerStats(ran.stdout)
  } catch {
    return {}
  }
}

const total = (shares: Readonly<Record<string, Usage>>): Usage =>
  Object.values(shares).reduce((sum, u) => ({ cpu: sum.cpu + u.cpu, ramBytes: sum.ramBytes + u.ramBytes }), { cpu: 0, ramBytes: 0 })

const gb = (bytes: number) => (bytes / 1024 ** 3).toFixed(1)

/** CPU as a share of the whole machine, memory in GB: `12% · 1.4 GB`. */
export const usageText = (u: Usage, cores: number) =>
  `${Math.round(u.cpu / Math.max(1, cores))}% · ${gb(u.ramBytes)} GB`

const step = (value: number, bounds: readonly number[]) => bounds.filter(b => value >= b).length

/** An agent's CPU, percent of one core: busy from 5, hard at work from 50, heavy from 150. */
const AGENT_CPU = [5, 50, 150]
/** An agent's memory in GB: a quarter of the bar from 0.2, then 0.75, 1.5 and 3. */
const AGENT_RAM_GB = [0.2, 0.75, 1.5, 3]
/** A container's CPU, percent of one core. */
const CONTAINER_CPU = [2, 25, 100]

/** A report in the coarse steps the scene draws. */
export function levelsOf(report: UsageReport): UsageLevels {
  const agents = total(report.agents)
  const stack = total(report.containers)
  const cores = Math.max(1, report.machine.cores)

  return {
    agents: Object.fromEntries(
      Object.entries(report.agents).map(([id, u]) => [
        id,
        { cpu: step(u.cpu, AGENT_CPU), ram: step(u.ramBytes / 1024 ** 3, AGENT_RAM_GB) },
      ]),
    ),
    containers: Object.fromEntries(
      Object.entries(report.containers).map(([name, u]) => [name, step(u.cpu, CONTAINER_CPU)]),
    ),
    cpuPercent: Math.min(100, Math.round((agents.cpu + stack.cpu) / cores / 10) * 10),
    ramGb: Math.round((agents.ramBytes + stack.ramBytes) / 1024 ** 3),
    machineGb: Math.round(report.machine.ramBytes / 1024 ** 3),
    cores,
  }
}

/** A report as it is shown: rounded, so jitter does not redraw a view. */
export function settle(report: UsageReport): UsageReport {
  const round = (shares: Readonly<Record<string, Usage>>) =>
    Object.fromEntries(
      Object.entries(shares).map(([id, u]) => [id, { cpu: Math.round(u.cpu), ramBytes: Math.round(u.ramBytes / 1e8) * 1e8 }]),
    )

  return { ...report, agents: round(report.agents), containers: round(report.containers) }
}

/** How long one session's measurement serves the others before it is stale. */
export const SHARED_FOR_MS = 15_000

/** A measurement left for the other sessions of the repository to read. */
export type SharedUsage = { at: number; by: string; report: UsageReport }

export const sharedFile = (stateDir: string) => `${stateDir}/usage.json`

export function parseShared(text: string): SharedUsage | undefined {
  try {
    const parsed = JSON.parse(text) as Partial<SharedUsage>
    const report = parsed.report
    if (typeof parsed.at !== 'number' || typeof parsed.by !== 'string' || typeof report !== 'object' || report === null) return undefined
    if (typeof report.agents !== 'object' || typeof report.containers !== 'object' || typeof report.machine?.cores !== 'number') return undefined

    return { at: parsed.at, by: parsed.by, report }
  } catch {
    return undefined
  }
}

/**
 * Who measures: many sessions want the figures, one pays for them. A session
 * that watches measures when nobody has lately, and goes on while it is the
 * one measuring; everyone else reads what it left.
 */
export function shouldMeasure(
  shared: SharedUsage | undefined,
  sessionId: string,
  isWatching: boolean,
  now: number,
): boolean {
  if (!isWatching) return false

  return shared === undefined || shared.by === sessionId || now - shared.at > SHARED_FOR_MS
}
