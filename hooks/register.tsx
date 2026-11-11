import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { AgentRecord, Limit, ResourceView, Snapshot, Stage, Usage, UsageReport, ViewMode, ViewToggles } from '../types'
import { bandItems, noticesBetween, statusText, toBrief } from './core/brief'
import type { Tone } from './core/brief'
import type { Notice } from './core/brief'
import { DEFAULTS, GLOBAL_CONFIG, GUIDE, PROJECT_CONFIG, readConfig, readProjectConfig, viewOf } from './core/config'
import type { Config } from './core/config'
import { demoPlanSnapshot, demoSnapshot, demoUsage } from './core/demo'
import { describeModes, loadModes, MODE_ENDED, modeBrief } from './core/modes'
import type { Mode } from './core/modes'
import { isPlanTool, isSessionList } from './core/plan'
import { classify, DEFAULT_PATTERNS } from './core/derive'
import type { Patterns } from './core/derive'
import { inspectImages } from './core/docker'
import { locate, prState } from './core/git'
import { EMPTY, newRecord, toSnapshot } from './core/model'
import type { Identity } from './core/model'
import { apply } from './core/reduce'
import type { StageEvent } from './core/reduce'
import {
  applyOp,
  describeResource,
  emptyResource,
  resolveAgent,
  resourceName,
  toResourceView,
} from './core/resource'
import type { ResourceOp } from './core/resource'
import { load, loadAll, loadResources, prune, save, saveResource } from './core/store'
import {
  measure,
  parseShared,
  readMachine,
  sampleContainers,
  sample,
  settle,
  systemLoad,
  sharedFile,
  SHARED_FOR_MS,
  shouldMeasure,
} from './core/usage'
import type { Machine, Sys } from './core/usage'
import { appleLanguage, langFrom, namesLanguage, WORDS } from './scene/labels'
import type { Lang } from './scene/labels'
import { fitLayout, fitPlan } from './scene/layout'
import type { Layout } from './scene/layout'
import { neon } from './scene/neon'
import { renderPlan } from './scene/plan'
import { ASK, BAD, WARN } from './scene/skin'
import { describeScene, MAX_SOURCE, renderScene } from './scene/scene'
import { advance } from './scene/stage'

const PANE = 'agent-stage'
const TOOL = 'mcp__agent-stage-cc__resource'
/** Every this many polls the machine is asked which images the scope runs. */
const INSPECT_EVERY = 3
/** Every this many polls an agent with an open PR asks what became of it. */
const PR_CHECK_EVERY = 20
/** Every this many polls the processes are measured, and the containers. */
const USAGE_EVERY = 2
const CONTAINERS_EVERY = 6
/** Every this many polls the account's rate limits are read. */
const LIMITS_EVERY = 5
/** Every this many polls the config files are read again. */
const CONFIG_EVERY = 10
const ACTIONS = ['status', 'grant', 'release', 'queue', 'unqueue', 'order', 'scope'] as const
type ResourceAction = (typeof ACTIONS)[number]

const TOOL_DESCRIPTION = [
  'Records who holds a shared resource that only one agent should use at a time (by default the local `stack` of containers) and who waits for it, and shows it on the Agent Stage.',
  'It only records and shows: nothing is blocked, restored or enforced. Who gets the resource is decided by the person or the coordinator.',
  '`grant` gives the resource to an agent and `release` frees it; `queue`, `unqueue` and `order` manage the waiting line.',
  '`scope` is for the holder, before it changes anything: the containers it will touch, so swapped images can be told from the originals.',
  '`status` reads the current state of every agent and resource.',
  '`agent` is a worktree name or a distinctive part of one; left out, it means the calling session.',
].join(' ')

const TOOL_SCHEMA = {
  type: 'object',
  properties: {
    action: { type: 'string', enum: [...ACTIONS] },
    resource: { type: 'string', description: 'Name of the resource; `stack` when left out.' },
    agent: { type: 'string', description: 'For grant, queue and unqueue.' },
    agents: { type: 'array', items: { type: 'string' }, description: 'For order: the queue, first in line first.' },
    containers: { type: 'array', items: { type: 'string' }, description: 'For scope: container names.' },
  },
  required: ['action'],
  additionalProperties: false,
}

const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []
/** A change of the last action alone is written at most this often. */
const QUIET_WRITE_MS = 3000

const snapshot = atom({ plugin: 'agent-stage-cc', key: 'snapshot' } as const, EMPTY, {
  shape: 'snapshot-2',
})

const stageNow = atom({ plugin: 'agent-stage-cc', key: 'stage' } as const, null, {
  shape: 'stage-5',
})
const ALL_ON: ViewToggles = { focus: false, labels: true, links: true }
const view = atom({ plugin: 'agent-stage-cc', key: 'view' } as const, ALL_ON)
const demo = atom({ plugin: 'agent-stage-cc', key: 'demo' } as const, false)
/** The scene a person picked; null leaves it to the config. */
const viewMode = atom({ plugin: 'agent-stage-cc', key: 'viewMode' } as const, null)
/** The working mode turned on for the session, by name: kept over a reload. */
const workMode = atom({ plugin: 'agent-stage-cc', key: 'workMode' } as const, null)
const briefNow = atom({ plugin: 'agent-stage-cc', key: 'brief' } as const, null, { shape: 'brief-4' })
const bandHidden = atom({ plugin: 'agent-stage-cc', key: 'bandHidden' } as const, false)

/** The band's colors: one per figure, amber and red for what runs out. */
const TONES: Record<Tone, string> = {
  cpu: '#60a5fa', ram: '#5eead4', ownCpu: '#4b78b8', ownRam: '#3f9f95', short: '#a78bfa', long: '#c4b5fd', other: '#9aa5b8',
  low: WARN, out: BAD, ask: ASK, bad: BAD,
}

const VIEWS: Record<Lang, Record<ViewMode, string>> = {
  en: { auto: 'View: auto', team: 'View: team', plan: 'View: plan' },
  pl: { auto: 'Widok: auto', team: 'Widok: zespół', plan: 'Widok: plan' },
}
/** Said on the view switch when a plan is asked for and nobody keeps one. */
const NO_PLAN: Record<Lang, string> = { en: ' (no plan yet)', pl: ' (brak planu)' }
const NEXT_VIEW: Record<ViewMode, ViewMode> = { auto: 'team', team: 'plan', plan: 'auto' }

const TOGGLES: Record<Lang, Record<keyof ViewToggles, string>> = {
  en: { focus: 'Needs attention only', labels: 'State labels', links: 'Links' },
  pl: { focus: 'Tylko wymagające uwagi', labels: 'Opisy stanów', links: 'Połączenia' },
}

/** What this session knows of itself between events; lost on a reload. */
type Self = {
  who: Identity | undefined
  rec: AgentRecord | undefined
  written: string
  writtenAt: number
  isLocated: boolean
  /** What the views last got, so an unchanged poll redraws nothing. */
  shown: string
  stage: Stage | null
  polls: number
  isDemo: boolean
  /** Which invented data the demo shows. */
  demoKind: 'team' | 'plan'
  /** The working mode the person turned on for this session. */
  mode: Mode | null
  lang: Lang
  /** The language the machine itself is set to; the config may name another. */
  systemLang: Lang
  utcOffsetMinutes: number
  config: Config
  patterns: Patterns
  /** The stage as last seen, to tell what happened since; and the brief shown. */
  last: Snapshot | null
  briefShown: string
  /** The machine as asked once; null where no probe knows the platform. */
  machine: Machine | null | undefined
  /** CPU time each process had at the last sample, and when that was. */
  cpuSeconds: Record<number, number> | null
  /** The machine's last reading, for the CPU rate of the next. */
  system: Sys | null
  sampledAt: number
  containers: Record<string, Usage>
  usage: UsageReport | null
  limits: Limit[]
  sessionId: string
  /** The last thing that went wrong in the background, for `status` to say. */
  trouble: string
  /** What the machine last said each container in scope runs; null: unknown. */
  images: Record<string, string> | null
  /** The pane's last measured size, kept for tuning the pixel estimate. */
  pane: string
  paneWritten: string
}

/** What a command prints, or nothing where the machine has no such command. */
async function printed($: EngineInterface, argv: readonly string[]): Promise<string> {
  try {
    const ran = await $.process.run([...argv], { timeoutMs: 5000 })

    return ran.exitCode === 0 ? ran.stdout.trim() : ''
  } catch {
    return ''
  }
}

/** The machine's language and clock offset, asked once: hooks have no locale. */
async function readLocale($: EngineInterface, self: Self): Promise<void> {
  try {
    const env = [
      await $.env.get('LC_ALL'),
      await $.env.get('LC_MESSAGES'),
      await $.env.get('LANG'),
      (await $.env.get('LANGUAGE'))?.split(':')[0],
    ]
    // An app started from a dock or a menu often has no locale in its
    // environment: then the system's own setting is asked, each in its way.
    const asked = env.some(namesLanguage) ? [] : [
      appleLanguage(await printed($, ['defaults', 'read', '-g', 'AppleLanguages'])),
      await printed($, ['powershell', '-NoProfile', '-Command', '(Get-UICulture).Name']),
    ]
    self.systemLang = langFrom([...env, ...asked])
    self.lang = self.config.language === 'auto' ? self.systemLang : self.config.language
    const zone = await $.process.run(['date', '+%z'], { timeoutMs: 5000 })
    const match = /^([+-])(\d\d)(\d\d)/.exec(zone.stdout.trim())
    if (match) self.utcOffsetMinutes = (match[1] === '-' ? -1 : 1) * (Number(match[2]) * 60 + Number(match[3]))
  } catch {
    // English and UTC stand when the machine does not say.
  }
}

// Who this session is: asked of git once, and again when the session moved.
async function locateSelf($: EngineInterface, self: Self, at: number): Promise<void> {
  const cwd = await $.session.cwd()
  self.who = await locate($, cwd)
  self.isLocated = true
  if (self.who === undefined) {
    self.rec = undefined

    return
  }
  const sessionId = await $.session.id()
  const stored = await load($, self.who.stateDir, self.who.id)
  self.rec = {
    ...(stored ?? newRecord(self.who, sessionId, at)),
    worktree: self.who.worktree,
    branch: self.who.branch,
  }
}

async function emit(
  $: EngineInterface,
  self: Self,
  make: (at: number) => StageEvent,
): Promise<void> {
  try {
    const at = await $.clock.now()
    if (!self.isLocated) await locateSelf($, self, at)
    if (self.rec === undefined || self.who === undefined) return
    const before = self.rec
    self.rec = apply(self.rec, make(at))
    const { updatedAt: _a, lastAction: _b, lastActionAt: _c, ...core } = self.rec
    const key = JSON.stringify(core)
    if (key === self.written && at - self.writtenAt < QUIET_WRITE_MS) return
    self.written = key
    self.writtenAt = at
    await save($, self.who.stateDir, self.rec)
    if (before.state !== self.rec.state) void refresh($, self)
  } catch {
    // The stage watches; it never gets in the way of the work.
  }
}

/**
 * How loaded the machine is now, and what each agent and scoped container
 * costs it. Every session that shows the band or the pane wants the figures;
 * one of them measures and leaves the result for the rest.
 */
async function sampleUsage(
  $: EngineInterface,
  self: Self,
  stateDir: string,
  records: readonly AgentRecord[],
  scope: readonly string[],
  now: number,
): Promise<void> {
  if (self.sessionId === '') self.sessionId = await $.session.id()
  const panes = await $.ui.panes()
  const isWatching = panes.some(p => p.id === PANE && p.isPlaced) || (self.config.band && !(await read($, bandHidden)))
  const shared = parseShared(await $.fs.read(sharedFile(stateDir)).catch(() => ''))
  if (!shouldMeasure(shared, self.sessionId, isWatching, now)) {
    self.cpuSeconds = null
    self.system = null
    // Someone else's fresh figures, or none worth showing.
    self.usage = shared !== undefined && now - shared.at <= SHARED_FOR_MS * 2 ? shared.report : null

    return
  }
  if (self.polls % USAGE_EVERY !== 0 && self.usage !== null) return
  if (self.machine === undefined) self.machine = (await readMachine($)) ?? null
  const machine = self.machine
  if (machine === null) return
  const taken = await sample($, machine)
  const trees = records.map(r => ({ id: r.id, path: r.worktree }))
  const measured = measure(taken.procs, trees, self.cpuSeconds, now - self.sampledAt)
  const system = systemLoad(taken.system, self.system)
  self.cpuSeconds = measured.cpuSeconds
  self.system = taken.system ?? null
  self.sampledAt = now
  // A rate takes two readings: the first one only sets the mark.
  if (system === undefined) return
  if (scope.length === 0) self.containers = {}
  else if (self.polls % CONTAINERS_EVERY === 0) self.containers = await sampleContainers($, scope)
  self.usage = settle({
    system,
    agents: measured.usage,
    containers: self.containers,
    machine: { cores: machine.cores, ramBytes: machine.ramBytes },
  })
  await $.fs.write(sharedFile(stateDir), JSON.stringify({ at: now, by: self.sessionId, report: self.usage }))
}

/** The modes on offer in this session: built in, the person's, the project's. */
async function modesHere($: EngineInterface, self: Self): Promise<Mode[]> {
  if (!self.isLocated) await locateSelf($, self, await $.clock.now()).catch(() => undefined)

  return loadModes($, await $.env.get('HOME'), self.who?.worktree)
}

/**
 * `/stage agent`: turns a working mode on or off, or says which there are.
 * The rules go to the agent as a note it reads with the person's next words.
 */
async function modeCommand($: EngineInterface, self: Self, wanted: string | undefined): Promise<{ text: string; context?: string[] }> {
  const modes = await modesHere($, self)
  const name = wanted?.toLowerCase()
  if (name === undefined || name === '') return { text: describeModes(modes, self.mode?.name) }
  if (name === 'off') {
    const was = self.mode
    self.mode = null
    await update($, workMode, () => null)
    // The view the mode held goes back to the config's.
    if (was !== null) await update($, viewMode, () => null)
    await emit($, self, at => ({ kind: 'mode', at, name: null }))
    await refresh($, self)

    return was === null ? { text: 'No working mode was on.' } : { text: `Working mode "${was.name}" is off.`, context: [MODE_ENDED] }
  }
  const mode = modes.find(m => m.name === name)
  if (mode === undefined) return { text: `No working mode "${name}". ${describeModes(modes, self.mode?.name)}` }
  self.mode = mode
  self.writtenAt = 0
  await update($, workMode, () => mode.name)
  await emit($, self, at => ({ kind: 'mode', at, name: mode.name, ...(mode.role === undefined ? {} : { role: mode.role }) }))
  // A mode is watched on the scene it names: its own agent's plan, or the team.
  await update($, viewMode, () => mode.view)
  await refresh($, self)
  await $.ui.open({ id: PANE, title: 'Agent Stage' })

  return {
    text: `Working mode "${mode.name}" is on (${mode.title}). Say what you want done.`,
    context: [modeBrief(mode)],
  }
}

/**
 * The person's settings and the project's own patterns, read again now and
 * then so an edit takes hold without a restart. A missing file is the defaults.
 */
async function loadConfig($: EngineInterface, self: Self): Promise<void> {
  const home = await $.env.get('HOME')
  const mine = home === undefined ? '' : await $.fs.read(`${home}/${GLOBAL_CONFIG}`).catch(() => '')
  self.config = mine === '' ? DEFAULTS : readConfig(mine)
  self.lang = self.config.language === 'auto' ? self.systemLang : self.config.language
  const theirs = self.who === undefined ? '' : await $.fs.read(`${self.who.worktree}/${PROJECT_CONFIG}`).catch(() => '')
  const project = theirs === '' ? {} : readProjectConfig(theirs)
  self.patterns = {
    test: project.test ?? DEFAULT_PATTERNS.test,
    coordinate: project.coordinate ?? DEFAULT_PATTERNS.coordinate,
  }
}

/** How much of the account's rate-limit windows is used, as Claude Code knows it. */
async function readLimits($: EngineInterface, self: Self): Promise<void> {
  if (self.polls % LIMITS_EVERY !== 1 && self.limits.length > 0) return
  try {
    const usage = await $.session.usage()
    self.limits = usage.rateLimits.map(l => ({
      kind: l.kind,
      percentUsed: l.percentUsed,
      ...(l.resetsAt === undefined ? {} : { resetsAt: l.resetsAt }),
    }))
  } catch {
    // Off a subscription there are no windows to show.
  }
}

/** Tells the person what just happened: natively where possible, else a toast. */
async function announce($: EngineInterface, self: Self, notices: readonly Notice[]): Promise<void> {
  const say = WORDS[self.lang].notice
  for (const notice of notices) {
    const text = notice.kind === 'released'
      ? say.released(notice.resource, notice.by)
      : notice.kind === 'question'
        ? notice.isUrgent ? say.urgent(notice.agent) : say.question(notice.agent)
        : say[notice.kind](notice.agent)
    const sent = await $.ui.notify(text, { title: 'Agent Stage' }).catch(() => undefined)
    if (sent?.isSent !== true) $.ui.toast(text)
  }
}

/** The band and the status line follow the brief; the lead session announces. */
async function brief($: EngineInterface, self: Self, next: Snapshot): Promise<void> {
  await readLimits($, self)
  const facts = toBrief(next, self.usage, self.limits)
  const key = JSON.stringify(facts)
  if (key !== self.briefShown) {
    self.briefShown = key
    await update($, briefNow, () => facts)
    $.ui.status(statusText(facts, WORDS[self.lang]))
  }
  if (self.isDemo) return
  const before = self.last
  self.last = next
  // One session speaks for the stage, or every session would say the same.
  if (before === null || self.who === undefined || next.coordinators[0] !== self.who.id) return
  const mine = self.who.id
  const notices = noticesBetween(before, next, self.config.notify).filter(n => n.kind === 'released' || n.agent !== mine)
  await announce($, self, notices)
}

/** A merge or a close happens on the forge, so an open PR is asked after. */
async function checkPr($: EngineInterface, self: Self): Promise<void> {
  const mine = self.rec
  if (mine?.pr === undefined) return
  const found = await prState($, mine.worktree, mine.pr.url)
  if (found === undefined) return
  self.writtenAt = 0
  await emit($, self, at => ({ kind: 'pr-state', at, ...found }))
}

async function refresh($: EngineInterface, self: Self): Promise<void> {
  try {
    const now = await $.clock.now()
    self.polls += 1
    if (self.polls % CONFIG_EVERY === 1) await loadConfig($, self)
    if (!self.isDemo && self.polls % PR_CHECK_EVERY === 0) await checkPr($, self)
    if (self.pane !== self.paneWritten && self.who !== undefined) {
      self.paneWritten = self.pane
      await $.fs.write(`${self.who.stateDir}/pane.json`, self.pane)
    }
    let next: Snapshot
    if (self.isDemo) {
      next = self.demoKind === 'plan' ? demoPlanSnapshot(self.polls, now) : demoSnapshot(Math.floor(self.polls / 2), now)
      self.usage = demoUsage(next)
    } else {
      if (self.who === undefined) return
      const stateDir = self.who.stateDir
      const records = await prune($, stateDir, await loadAll($, stateDir), now)
      const resources = await loadResources($, stateDir)
      // The machine is asked only while someone watches and there is a scope.
      const scope = resources.flatMap(r => r.members)
      if (scope.length === 0) self.images = null
      else if (self.pane !== '' && (self.images === null || self.polls % INSPECT_EVERY === 0)) {
        self.images = await inspectImages($, scope)
      }
      await sampleUsage($, self, stateDir, records, scope, now)
      const views = resources.map(r => toResourceView(r, records, self.images, now))
      next = toSnapshot(records, now, { asleepAfterMs: self.config.asleepAfterMs }, views)
    }
    const shown = JSON.stringify(next)
    if (shown !== self.shown) {
      self.shown = shown
      await update($, snapshot, () => next)
    }
    await brief($, self, next)
    // The scene is redrawn only when what a person would see has changed.
    const mode = (await read($, viewMode)) ?? self.config.view
    const stage = advance(self.stage, next, self.usage, now, { view: mode, ...(self.who === undefined ? {} : { self: self.who.id }) })
    if (stage !== self.stage) {
      self.stage = stage
      await update($, stageNow, () => stage)
    }
  } catch (error) {
    // A poll that fails is tried again on the next tick.
    self.trouble = `poll: ${error instanceof Error ? error.message : String(error)}`.slice(0, 300)
  }
}

/** What a person or a coordinator asks of a shared resource, in one place. */
async function resourceAction(
  $: EngineInterface,
  self: Self,
  input: Readonly<Record<string, unknown>>,
): Promise<{ text: string; isError: boolean }> {
  const fail = (text: string) => ({ text, isError: true })
  const now = await $.clock.now()
  if (!self.isLocated) await locateSelf($, self, now)
  if (self.who === undefined) return fail('Agent Stage keeps its state in a git repository; this session is not in one.')
  const action = ACTIONS.find(a => a === input.action)
  if (action === undefined) return fail(`action must be one of: ${ACTIONS.join(', ')}`)
  const stateDir = self.who.stateDir
  const records = await loadAll($, stateDir)
  const resources = await loadResources($, stateDir)
  const describe = (list: readonly ResourceView[]) =>
    [
      ...(list.length === 0 ? ['no shared resource is in use'] : list.map(describeResource)),
      ...records.map(r => `${r.id}: ${r.state}${r.role === 'coordinator' ? ' (coordinator)' : ''}${r.lastAction === '' ? '' : `, last: ${r.lastAction}`}`),
      ...(self.trouble === '' ? [] : [`trouble: ${self.trouble}`]),
    ].join('\n')
  if (action === 'status') {
    return { text: describe(resources.map(r => toResourceView(r, records, self.images, now))), isError: false }
  }

  const name = resourceName(typeof input.resource === 'string' ? input.resource : undefined)
  const rec = resources.find(r => r.name === name) ?? emptyResource(name, now)
  const ids = records.filter(r => r.state !== 'done').map(r => r.id)
  const named = (query: unknown) => resolveAgent(ids, typeof query === 'string' && query.trim() !== '' ? query : self.who?.id ?? '')
  let op: ResourceOp
  let scope = rec.members
  if (action === 'grant' || action === 'queue' || action === 'unqueue') {
    const who = named(input.agent)
    if ('error' in who) return fail(who.error)
    op = { kind: action, agent: who.id }
  } else if (action === 'order') {
    const order: string[] = []
    for (const query of strings(input.agents)) {
      const who = named(query)
      if ('error' in who) return fail(who.error)
      order.push(who.id)
    }
    op = { kind: 'order', agents: order }
  } else if (action === 'scope') {
    scope = strings(input.containers)
    op = { kind: 'scope', containers: scope }
  } else {
    op = { kind: 'release' }
  }
  // A grant and a scope take the machine's word for what runs now.
  const images = action === 'grant' || action === 'scope' ? await inspectImages($, scope) : null
  const next = applyOp(rec, op, now, images ?? {})
  await saveResource($, stateDir, next, await $.session.id())
  if (images !== null) self.images = { ...(self.images ?? {}), ...images }
  await refresh($, self)
  const unknown = action === 'scope' && images !== null ? next.members.filter(m => images[m] === undefined) : []
  const note = action === 'scope' && images === null
    ? '\ndocker did not answer, so swapped images cannot be shown'
    : unknown.length > 0 ? `\nno such container: ${unknown.join(', ')}` : ''

  return { text: `${describeResource(toResourceView(next, records, self.images, now))}${note}`, isError: false }
}

export const register: Register = on => {
  const self: Self = {
    who: undefined, rec: undefined, written: '', writtenAt: 0, isLocated: false,
    shown: '', stage: null, polls: 0, isDemo: false, demoKind: 'team', mode: null, lang: 'en', systemLang: 'en', utcOffsetMinutes: 0,
    pane: '', paneWritten: '', images: null, config: DEFAULTS, patterns: DEFAULT_PATTERNS, last: null, briefShown: '',
    machine: undefined, cpuSeconds: null, system: null, sampledAt: 0, containers: {}, usage: null, limits: [], sessionId: '', trouble: '',
  }

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'stage',
      description: 'Open the Agent Stage pane',
      argumentHint: '[agent <mode>|demo [plan]|live|view <auto|team|plan>|band|status|grant <agent>|release|queue <agent>|order <agents>]',
    })
    await $.tool.register({
      name: 'resource',
      description: TOOL_DESCRIPTION,
      inputSchema: TOOL_SCHEMA,
      isDeferred: false,
    })
    await readLocale($, self)
    await loadConfig($, self).catch(() => undefined)
    self.isDemo = await read($, demo)
    const kept = await read($, workMode)
    if (typeof kept === 'string') self.mode = (await modesHere($, self).catch(() => [])).find(m => m.name === kept) ?? null
    const sessionId = await $.session.id()
    await emit($, self, at => ({ kind: 'session-start', at, sessionId }))
    void refresh($, self)
    $.clock.every(self.config.refreshMs, () => void refresh($, self))

    return next(e)
  })

  // How to keep the stage's record, told once in each session's instructions.
  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    // A working mode's rules head every new thread while the mode is on.
    const mode = self.mode === null ? [] : [{ id: 'agent-stage-cc:mode', text: modeBrief(self.mode), scope: 'session' as const }]
    const guide = self.config.guide ? [{ id: 'agent-stage-cc:guide', text: GUIDE, scope: 'session' as const }] : []

    return { sections: [...composed.sections, ...guide, ...mode] }
  })

  on('session.end', async ($, e, next) => {
    self.writtenAt = 0
    await emit($, self, at => ({ kind: 'session-end', at }))

    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) {
      self.isLocated = false
      await emit($, self, at => ({ kind: 'turn-start', at }))
    }

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) {
      self.writtenAt = 0
      await emit($, self, at => ({ kind: 'turn-end', at, answer: e.answer, reason: e.reason }))
    }

    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    const action = classify(String(e.tool), e as unknown as Record<string, unknown>, self.patterns)
    await emit($, self, at => ({ kind: 'tool-start', at, action }))
    const ran = await next(e)
    const isError = ran.deny !== undefined || ran.isError === true
    const output = ran.deny === undefined && typeof ran.text === 'string' ? ran.text : ''
    await emit($, self, at => ({ kind: 'tool-end', at, action, isError, output }))
    // A subagent's own list is not the session's plan; the tasks it files are.
    if (!isError && isPlanTool(String(e.tool)) && (e.agentId === undefined || isSessionList(String(e.tool)))) {
      const input = e as unknown as Record<string, unknown>
      self.writtenAt = 0
      await emit($, self, at => ({ kind: 'plan-call', at, tool: String(e.tool), input, result: ran.result }))
    }

    return ran
    // Watching must never cost a tool call: a failure here hands the call on.
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: TOOL }, async ($, e) => {
    const done = await resourceAction($, self, e as unknown as Record<string, unknown>)

    return done.isError ? { result: done.text, isError: true } : { result: done.text }
  })

  on('command.run', { command: 'stage' }, async ($, e) => {
    const [wanted = '', ...rest] = e.args.trim().split(/\s+/)
    const verb = wanted.toLowerCase()
    let said = ''
    if (verb === 'band') {
      const hidden = !(await read($, bandHidden))
      await update($, bandHidden, () => hidden)

      return { text: hidden ? 'Agent Stage band hidden.' : 'Agent Stage band shown.' }
    }
    if (verb === 'agent') return modeCommand($, self, rest[0])
    if (verb === 'view') {
      const picked = viewOf(rest[0]?.toLowerCase())
      if (picked === undefined) return { text: 'Usage: /stage view auto|team|plan' }
      await update($, viewMode, () => picked)
      await refresh($, self)
      // Asked for a plan where nobody keeps one, the pane would show the team unexplained.
      const shown = (self.stage?.plan ?? null) === null ? 'the team' : `the plan of ${self.stage?.plan?.agent.id ?? ''}`
      said = picked === 'plan' && (self.stage?.plan ?? null) === null
        ? ' View: plan. No agent keeps a task list right now, so the team is shown until one does.'
        : ` View: ${picked}, showing ${shown}.`
    } else if (verb === 'demo' || verb === 'live') {
      self.isDemo = verb === 'demo'
      self.demoKind = rest[0]?.toLowerCase() === 'plan' ? 'plan' : 'team'
      self.stage = null
      // Figures of the other mode are not this one's.
      self.usage = null
      self.cpuSeconds = null
      self.system = null
      self.last = null
      await update($, demo, () => self.isDemo)
      await refresh($, self)
    } else if ((ACTIONS as readonly string[]).includes(verb)) {
      const action = verb as ResourceAction
      const done = await resourceAction($, self, {
        action,
        ...(action === 'order' ? { agents: rest } : action === 'scope' ? { containers: rest } : rest[0] === undefined ? {} : { agent: rest[0] }),
      })

      return { text: done.text }
    }
    const opened = await $.ui.open({ id: PANE, title: 'Agent Stage' })
    const mode = self.isDemo ? ' (demo data)' : ''

    return { text: opened.isPlaced ? `Agent Stage opened${mode}.${said}` : `Agent Stage did not open: ${opened.reason}` }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const stage = await read($, stageNow)
    const toggles = await read($, view)
    const { Box, Text, Button } = $.ui.resolve(e)
    const words = WORDS[self.lang]

    if (stage === null) return <Text dimColor>{words.worktrees(0)}</Text>

    // A surface without a vector element gets the same facts as a list.
    const marks = { done: '✓', active: '▸', pending: '·' } as const
    const list = (
      <Box flexDirection="column">
        {(stage.plan?.steps ?? []).map(s => (
          <Text key={`step-${s.key}`} dimColor={s.status === 'pending'}>
            {marks[s.status]} {s.ordinal}. {s.text}
          </Text>
        ))}
        {[...(stage.coordinator === null ? [] : [stage.coordinator]), ...stage.agents].map(a => (
          <Text color={a.needsAttention ? '#ff5fa2' : undefined} dimColor={a.isAsleep}>
            {a.id} · {a.isAsleep ? words.asleep : words.state[a.state]}
            {a.lastAction === '' ? '' : ` · ${a.lastAction}`}
          </Text>
        ))}
      </Box>
    )
    if (e.surface === 'terminal') return list

    const plan = stage.plan ?? null
    const planFit = plan === null ? null : fitPlan(e.props.bodyColumns, e.props.scroll.bodyRows, stage.resource !== null)
    const { layout, pixelWidth, pixelHeight } = planFit ?? fitLayout(e.props.bodyColumns, e.props.scroll.bodyRows, stage.resource !== null)
    self.pane = JSON.stringify({
      bodyColumns: e.props.bodyColumns,
      bodyRows: e.props.scroll.bodyRows,
      viewport: e.viewport ?? null,
      pixelWidth,
      pixelHeight,
    })
    const options = { ...toggles, lang: self.lang, utcOffsetMinutes: self.utcOffsetMinutes, pixelWidth, pixelHeight }
    const source = plan !== null && planFit !== null
      ? renderPlan(stage, plan, planFit.layout, neon, options)
      : renderScene(stage, layout as Layout, neon, options)
    if (source.length > MAX_SOURCE) return list
    const { Svg } = $.ui.resolve(e)
    const names = TOGGLES[self.lang]
    const picked = (await read($, viewMode)) ?? self.config.view
    const toggle = (key: keyof ViewToggles) => (
      <Button
        key={key}
        label={`${toggles[key] ? '●' : '○'} ${names[key]}`}
        onPress={() => update($, view, v => ({ ...(v ?? ALL_ON), [key]: !(v ?? ALL_ON)[key] }))}
      />
    )

    return (
      <Box flexDirection="column" gap={1}>
        <Box gap={1}>
          {toggle('focus')}
          {toggle('labels')}
          {toggle('links')}
          <Button
            key="view"
            label={`◐ ${VIEWS[self.lang][picked]}${picked === 'plan' && plan === null ? NO_PLAN[self.lang] : ''}`}
            onPress={async () => {
              await update($, viewMode, () => NEXT_VIEW[picked])
              await refresh($, self)
            }}
          />
        </Box>
        <Svg
          source={source}
          alt={describeScene(stage, self.lang)}
          width={pixelWidth}
          height={pixelHeight}
          isInteractive
        />
      </Box>
    )
  })

  // The standing brief above the prompt: bare figures, each in its own
  // color; a pointer over one says what it is.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const facts = await read($, briefNow)
    const isHidden = await read($, bandHidden)
    if (e.props.hasSurvey || isHidden || !self.config.band || facts === null) return next(e)
    const words = WORDS[self.lang]
    const items = bandItems(facts, words)
    if (items.length === 0) return next(e)
    const { Box, Text, Button } = $.ui.resolve(e)

    return (
      <Box gap={2}>
        {items.map(item => (
          <Box key={`stage-${item.key}`}>
            <Text color={TONES[item.tone]}>{item.text}</Text>
            <Box display="none" hover={{ display: 'flex' }}>
              <Text dimColor> {item.hint}</Text>
            </Box>
          </Box>
        ))}
        <Box gap={1}>
          <Button
            key="stage-open"
            plain
            label={words.scene}
            onPress={async () => {
              await $.ui.open({ id: PANE, title: 'Agent Stage' })
            }}
          />
          <Button key="stage-hide" plain role="dismiss" label="×" onPress={() => update($, bandHidden, () => true)} />
        </Box>
      </Box>
    )
  })
}
