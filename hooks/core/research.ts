import type { ConcurrencySample, ProbeStatus, Research, ResearchProbe, ResearchSource } from '../../types'
import type { Action } from './derive'

// A session's research, read off what it does: the subagents it starts, the
// searches and reads that run, and the sources they turn up. No agent is
// asked to report any of it.

/** Probes kept in a record; past this many the oldest finished ones go. */
export const MAX_PROBES = 24
/** Domains kept in a record; past this many the list says it is full. */
export const MAX_SOURCES = 60
/** How far back the record of concurrency reaches, and in what steps. */
export const HISTORY_MS = 10 * 60_000
export const BUCKET_MS = 10_000
/** Steps of concurrency a scene shows: the whole of `HISTORY_MS`. */
export const SERIES = HISTORY_MS / BUCKET_MS
const MAX_LABEL = 80
/** A search answers with many links; this many are read of one call. */
const MAX_FOUND = 40

export const emptyResearch = (at: number): Research => ({
  since: at, inFlight: 0, calls: 0, probes: [], sources: [], history: [], peak: 0, peakAt: 0,
})

const record = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}

/** A tool of a connected server that searches or fetches, by the last part of its name. */
const SERVER_SEARCH = /^mcp__.+__(?:[a-z0-9]+_)*(?:search|fetch)(?:_[a-z0-9]+)*$/i
const SERVER_FETCH = /^mcp__.+__(?:[a-z0-9]+_)*fetch(?:_[a-z0-9]+)*$/i

/**
 * Whether a call searches or reads: what the stage already counts as
 * research (files, the web, read-only shell commands), and a connected
 * server's own search and fetch tools. Looking up tools is not research.
 */
export function isSearchCall(tool: string, action: Action): boolean {
  if (tool === 'ToolSearch') return false

  return action.kind === 'research' || SERVER_SEARCH.test(tool)
}

/** A web address's domain, without `www.`; undefined for anything else. */
export function domainOf(url: string): string | undefined {
  const host = /^https?:\/\/(?:[^/?#@\s]*@)?([^/?#:\s]+)/i.exec(url.trim())?.[1]
  if (host === undefined) return undefined
  const name = host.toLowerCase().replace(/\.$/, '').replace(/^www\d*\./, '')

  return /^[a-z0-9.-]+$/.test(name) && name.includes('.') && !name.startsWith('.') ? name.slice(0, MAX_LABEL) : undefined
}

/** A domain a call turned up, and whether a page of it was read or only found. */
export type Found = { domain: string; isRead: boolean }

const LINKS = /https?:\/\/[^\s"'<>()[\]{}\\`]+/g

/**
 * The domains one search or fetch turned up: the page a fetch read, the
 * links a search answered with. The tool's own record is read first; where
 * it has none, the links in what the model read.
 */
export function sourcesOf(tool: string, input: Readonly<Record<string, unknown>>, result: unknown, text: string): Found[] {
  const found = new Map<string, boolean>()
  const add = (url: unknown, isRead: boolean) => {
    const domain = typeof url === 'string' ? domainOf(url) : undefined
    if (domain !== undefined && found.size < MAX_FOUND) found.set(domain, (found.get(domain) ?? false) || isRead)
  }
  if (tool === 'WebFetch' || SERVER_FETCH.test(tool)) {
    add(record(result).url ?? input.url, true)
  } else if (tool === 'WebSearch' || SERVER_SEARCH.test(tool)) {
    const results = record(result).results
    for (const entry of Array.isArray(results) ? results : []) {
      const hits = record(entry).content
      for (const hit of Array.isArray(hits) ? hits : []) add(record(hit).url, false)
    }
    if (found.size === 0) for (const link of text.match(LINKS) ?? []) add(link, false)
  }

  return [...found].map(([domain, isRead]) => ({ domain, isRead }))
}

/** Every search and read in flight now, of the session and its probes. */
export const inFlightOf = (r: Research): number => r.inFlight + r.probes.reduce((sum, p) => sum + p.inFlight, 0)

/** Whether anything of the research runs now. */
export const isRunning = (r: Research): boolean => r.inFlight > 0 || r.probes.some(p => p.status === 'running')

/**
 * The record of concurrency once the number in flight went from `before` to
 * `after`: each step of ten seconds keeps the most that ran in it. A level
 * that held through steps without a change is written into them then.
 */
export function sampled(history: readonly ConcurrencySample[], before: number, after: number, at: number): ConcurrencySample[] {
  const bucket = Math.floor(at / BUCKET_MS) * BUCKET_MS
  const from = bucket - HISTORY_MS
  const kept = history.filter(s => s.at > from)
  const last = kept[kept.length - 1]
  if (last !== undefined && last.at >= bucket) {
    kept[kept.length - 1] = { at: last.at, n: Math.max(last.n, after) }

    return kept
  }
  if (last !== undefined && before > 0) {
    for (let b = Math.max(last.at + BUCKET_MS, from + BUCKET_MS); b < bucket; b += BUCKET_MS) kept.push({ at: b, n: before })
  }
  kept.push({ at: bucket, n: Math.max(before, after) })

  return kept.slice(-SERIES)
}

/** The research after a change of what runs: its record of concurrency and its peak follow. */
function leveled(prev: Research, next: Research, at: number): Research {
  const before = inFlightOf(prev)
  const after = inFlightOf(next)
  if (before === after) return next
  const history = sampled(next.history, before, after, at)

  return after > next.peak ? { ...next, history, peak: after, peakAt: at } : { ...next, history }
}

const clean = (text: string) => text.replace(/\s+/g, ' ').trim().slice(0, MAX_LABEL)

const finishedAt = (p: ResearchProbe) => p.endedAt ?? p.startedAt

/** No more probes than a record keeps: the oldest finished ones go first. */
function capped(probes: readonly ResearchProbe[]): ResearchProbe[] {
  if (probes.length <= MAX_PROBES) return [...probes]
  const over = probes.length - MAX_PROBES
  const gone = new Set(
    probes
      .filter(p => p.status !== 'running')
      .sort((a, b) => finishedAt(a) - finishedAt(b))
      .slice(0, over)
      .map(p => p.id),
  )

  return probes.filter(p => !gone.has(p.id)).slice(-MAX_PROBES)
}

function withProbe(r: Research, probe: ResearchProbe): Research {
  const at = r.probes.findIndex(p => p.id === probe.id)
  const probes = at < 0 ? [...r.probes, probe] : r.probes.map((p, i) => (i === at ? probe : p))

  return { ...r, probes: capped(probes) }
}

/** A probe at work: a finish it had is over. */
function running(p: ResearchProbe): ResearchProbe {
  const { endedAt: _was, ...rest } = p

  return { ...rest, status: 'running' }
}

const newProbe = (id: string, label: string, at: number): ResearchProbe => ({
  id, label, status: 'running', inFlight: 0, calls: 0, startedAt: at,
})

/**
 * A subagent began: at its spawn, with what it was sent for, or at a later
 * turn of its own. Only a spawn makes a probe: the engine's own forks
 * (compaction, memory) run loops of their own that nobody sent out. The
 * first name a probe was given stays.
 */
export function probeStarted(r: Research, at: number, id: string, label?: string, isBackground?: boolean): Research {
  const was = r.probes.find(p => p.id === id)
  if (was === undefined && label === undefined) return r
  const named = was?.label || clean(label ?? '')
  const base = running({ ...(was ?? newProbe(id, '', at)), label: named })
  const { isBackground: _seen, ...rest } = base
  const probe = isBackground === undefined ? base : isBackground ? { ...rest, isBackground: true as const } : rest

  return withProbe(r, probe)
}

const STATUS: Record<string, ProbeStatus> = { answer: 'done', aborted: 'stopped' }

/** A subagent's turn ended: it answered, was stopped, or failed. */
export function probeEnded(r: Research, at: number, id: string, reason: string): Research {
  const was = r.probes.find(p => p.id === id)
  if (was === undefined) return r

  return leveled(r, withProbe(r, { ...was, status: STATUS[reason] ?? 'failed', inFlight: 0, endedAt: at }), at)
}

/** A search or read began, in the session's own loop or in a probe's; a loop no spawn sent out is not the research's. */
export function callStarted(r: Research, at: number, loop?: string): Research {
  const counted = { ...r, calls: r.calls + 1 }
  if (loop === undefined) return leveled(r, { ...counted, inFlight: r.inFlight + 1 }, at)
  const was = r.probes.find(p => p.id === loop)
  if (was === undefined) return r
  const probe = running({ ...was, inFlight: was.inFlight + 1, calls: was.calls + 1 })

  return leveled(r, withProbe(counted, probe), at)
}

function withSources(r: Research, found: readonly Found[]): Research {
  if (found.length === 0) return r
  const sources: ResearchSource[] = [...r.sources]
  let isFull = r.sourcesCapped === true
  for (const f of found) {
    const at = sources.findIndex(s => s.domain === f.domain)
    const was = sources[at]
    if (was !== undefined) sources[at] = { ...was, hits: was.hits + 1, ...(f.isRead || was.isRead === true ? { isRead: true as const } : {}) }
    else if (sources.length < MAX_SOURCES) sources.push({ domain: f.domain, hits: 1, ...(f.isRead ? { isRead: true as const } : {}) })
    else isFull = true
  }

  return { ...r, sources, ...(isFull ? { sourcesCapped: true as const } : {}) }
}

/** A search or read ended, with the domains it turned up. */
export function callEnded(r: Research, at: number, loop?: string, found: readonly Found[] = []): Research {
  const was = loop === undefined ? undefined : r.probes.find(p => p.id === loop)
  if (loop !== undefined && was === undefined) return r
  const ended = was === undefined ? { ...r, inFlight: Math.max(0, r.inFlight - 1) } : withProbe(r, { ...was, inFlight: Math.max(0, was.inFlight - 1) })

  return leveled(r, withSources(ended, found), at)
}

/**
 * The session's own turn ended. What it ran is over, and so is every probe
 * that ran in the foreground of it, even one whose end was never heard: the
 * turn could not end before it did. Probes in the background run on.
 */
export function turnEnded(r: Research, at: number, reason: string): Research {
  const status: ProbeStatus = reason === 'answer' ? 'done' : 'stopped'
  const probes = r.probes.map(p => (p.status === 'running' && p.isBackground !== true ? { ...p, status, inFlight: 0, endedAt: at } : p))

  return leveled(r, { ...r, inFlight: 0, probes }, at)
}

/** The session ended: nothing of it runs any more. */
export function sessionEnded(r: Research, at: number): Research {
  const probes = r.probes.map(p => (p.status === 'running' ? { ...p, status: 'stopped' as const, inFlight: 0, endedAt: at } : { ...p, inFlight: 0 }))

  return leveled(r, { ...r, inFlight: 0, probes }, at)
}

/**
 * How many ran at once in each step of the last ten minutes, oldest first,
 * the last step ending now; and which step holds the peak, if any does.
 */
export function seriesOf(r: Research, now: number): { series: number[]; peakIndex: number } {
  const last = r.history[r.history.length - 1]
  const end = Math.floor(Math.max(now, last?.at ?? 0) / BUCKET_MS) * BUCKET_MS
  const start = end - (SERIES - 1) * BUCKET_MS
  const level = inFlightOf(r)
  const byStep = new Map(r.history.map(s => [s.at, s.n]))
  // Since the last change the level has held: up to now, it is what runs now.
  const series = Array.from({ length: SERIES }, (_, i) => {
    const at = start + i * BUCKET_MS

    return byStep.get(at) ?? (last === undefined || at > last.at ? level : 0)
  })
  const peakStep = (Math.floor(r.peakAt / BUCKET_MS) * BUCKET_MS - start) / BUCKET_MS
  const peakIndex = r.peak > 0 && peakStep >= 0 && peakStep < SERIES && (series[peakStep] ?? 0) >= r.peak ? peakStep : -1

  return { series, peakIndex }
}

const isNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)
const PROBE_STATUS = new Set<unknown>(['running', 'done', 'stopped', 'failed'])

function isProbe(value: unknown): value is ResearchProbe {
  const p = record(value)

  return typeof p.id === 'string' && typeof p.label === 'string' && PROBE_STATUS.has(p.status) &&
    isNumber(p.inFlight) && isNumber(p.calls) && isNumber(p.startedAt)
}

const isSource = (value: unknown): value is ResearchSource =>
  typeof record(value).domain === 'string' && isNumber(record(value).hits)

const isSample = (value: unknown): value is ConcurrencySample => isNumber(record(value).at) && isNumber(record(value).n)

/** Whether a stored value is a record of research this version can draw. */
export function isResearch(value: unknown): value is Research {
  const r = record(value)

  return isNumber(r.since) && isNumber(r.inFlight) && isNumber(r.calls) && isNumber(r.peak) && isNumber(r.peakAt) &&
    Array.isArray(r.probes) && r.probes.every(isProbe) &&
    Array.isArray(r.sources) && r.sources.every(isSource) &&
    Array.isArray(r.history) && r.history.every(isSample)
}
