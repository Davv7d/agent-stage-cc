import type { AgentRecord, AgentState, ConcurrencySample, PlanStep, ResearchProbe, ResearchSource, ResourceView, Snapshot, Usage, UsageReport } from '../../types'
import { toSnapshot } from './model'
import { BUCKET_MS, SERIES } from './research'

// A made-up team that walks through every state, for trying the scene and
// skins without real agents. Every name here is invented.
const NAMES = [
  'billing-export', 'login-redirect', 'audit-log', 'search-index', 'notifier-refactor',
  'deps-bump', 'cache-warmup', 'pdf-render', 'rate-limit', 'i18n-dates',
]

/** `wait`: the agent wants the shared stack, and holds it once it is its turn. */
const CYCLE = [
  'research', 'coding', 'coding', 'question', 'coding', 'wait', 'wait', 'wait', 'pr', 'pr', 'done',
] as const

const ACTIONS: Record<AgentState, string> = {
  idle: '', research: 'Grep "retry policy"', coding: 'Edit handler.ts', queue: '',
  testing: '$ npm test', failed: '$ npm test', question: 'asked a question',
  pr: '$ gh pr create --fill', done: '$ gh pr merge --squash',
}

const CONTAINERS = Array.from({ length: 20 }, (_, i) => `svc-${String(i + 1).padStart(2, '0')}`)

/** The demo team at one step: each step moves one or two agents on. */
export function demoSnapshot(step: number, now: number): Snapshot {
  const base = { v: 1 as const, sessionId: 'demo', isLive: true, lastActionAt: now, updatedAt: now }
  const waiting: { id: string; waited: number; index: number }[] = []
  const agents: AgentRecord[] = NAMES.map((id, i) => {
    const ticks = step + i * 7
    const turn = Math.floor(ticks / 8)
    const phase = turn % CYCLE.length
    const stage = CYCLE[phase] ?? 'coding'
    // Waiting agents go on with their code until the stack is theirs.
    const state: AgentState = stage === 'wait' ? 'coding' : stage
    if (stage === 'wait') waiting.push({ id, waited: (phase - 5) * 8 + (ticks % 8), index: i })

    return {
      ...base,
      id,
      worktree: `/demo/${id}`,
      branch: `feat/${id}`,
      role: 'agent',
      state,
      since: now,
      lastAction: ACTIONS[state],
      // A prompt arrives when a task starts and when a question is answered.
      promptAt: Math.floor(turn / CYCLE.length) * 2 + (phase >= 4 ? 2 : 1),
      ...(state === 'pr' ? { pr: { url: `https://example.com/demo/pull/${i + 1}` } } : {}),
    }
  })
  // Whoever has waited longest holds the stack and tests; the rest queue.
  waiting.sort((a, b) => b.waited - a.waited || a.index - b.index)
  const holder = waiting[0]
  const tested = agents.find(a => a.id === holder?.id)
  if (tested !== undefined) {
    tested.state = 'testing'
    tested.lastAction = ACTIONS.testing
  }
  const swapped = holder === undefined ? [] : [3, 9, 16].map(n => CONTAINERS[(n + holder.index * 5) % 20] ?? '')
  const resource: ResourceView = {
    v: 1, name: 'stack', holder: holder?.id ?? null, heldSince: now, releasedAt: 0,
    queue: waiting.slice(1).map(w => w.id), members: CONTAINERS, baseline: {}, updatedAt: now,
    swapped, phase: holder === undefined ? 'free' : 'held', isUrgent: false, isStale: false,
  }
  const lead: AgentRecord = {
    ...base, id: 'coordinator', worktree: '/demo', branch: 'main', role: 'coordinator',
    state: 'idle', since: now, lastAction: '', promptAt: 0,
  }

  return toSnapshot([lead, ...agents], now, { asleepAfterMs: 1e12 }, [resource])
}

const GB = 1024 ** 3
const COST: Partial<Record<AgentState, Usage>> = {
  research: { cpu: 60, ramBytes: 0.8 * GB },
  coding: { cpu: 110, ramBytes: 1.3 * GB },
  testing: { cpu: 240, ramBytes: 2.2 * GB },
}

/** Invented figures for the demo team, so the usage line has something to show. */
export function demoUsage(shot: Snapshot): UsageReport {
  // The containers the holder swapped are the ones its tests keep busy.
  const busy = new Set(shot.resources[0]?.swapped ?? [])
  const agents = Object.fromEntries(
    shot.agents.map(a => [a.id, COST[a.state] ?? { cpu: 8, ramBytes: 0.3 * GB }]),
  )
  const containers = Object.fromEntries(
    CONTAINERS.map(name => [name, { cpu: busy.has(name) ? 70 : 1, ramBytes: 0.3 * GB }]),
  )

  // The machine runs more than the stage: the rest is a steady share.
  const all = [...Object.values(agents), ...Object.values(containers)]
  const system = {
    cpuPercent: Math.min(100, 6 + all.reduce((sum, u) => sum + u.cpu, 0) / 16),
    ramBytes: 9 * GB + all.reduce((sum, u) => sum + u.ramBytes, 0),
  }

  return { system, agents, containers, machine: { cores: 16, ramBytes: 32 * GB } }
}

const PLAN = ['Read the handler', 'Add the retry policy', 'Cover it with tests', 'Wire the config flag', 'Update the docs', 'Open the pull request']
const WORK: AgentState[] = ['research', 'coding', 'testing']
/** After these steps the demo agent stops and waits, as in work done step by step. */
const STOPS = new Set([1, 3])

/**
 * One invented agent walking through a plan: three beats of work on each
 * step, a stop for the person after some, and a rest once all is done.
 */
export function demoPlanSnapshot(tick: number, now: number): Snapshot {
  const beats: { step: number; state: AgentState }[] = []
  PLAN.forEach((_, step) => {
    for (const state of WORK) beats.push({ step, state })
    if (STOPS.has(step)) beats.push({ step: step + 1, state: 'question' }, { step: step + 1, state: 'question' })
  })
  for (let i = 0; i < 3; i++) beats.push({ step: PLAN.length, state: 'idle' })
  const beat = beats[((tick % beats.length) + beats.length) % beats.length] ?? { step: 0, state: 'research' as AgentState }
  const isWorking = beat.state !== 'question' && beat.state !== 'idle'
  const plan: PlanStep[] = PLAN.map((text, i) =>
    i < beat.step ? { text, status: 'done', doneAt: i + 1 } : i === beat.step && isWorking ? { text, status: 'active' } : { text, status: 'pending' },
  )
  const agent: AgentRecord = {
    v: 1, sessionId: 'demo', isLive: true, id: 'retry-policy', worktree: '/demo/retry-policy', branch: 'feat/retry-policy',
    role: 'agent', state: beat.state, since: now, lastAction: ACTIONS[beat.state], lastActionAt: now,
    promptAt: beat.step, updatedAt: now, plan,
  }

  return toSnapshot([agent], now, { asleepAfterMs: 1e12 })
}

/** The research mode's phases, and the tick each begins at; the run rests after the last. */
const PHASES = [['Question', 0], ['Research plan', 3], ['Gathering', 6], ['Verification', 29], ['Report', 35]] as const
const RESEARCH_TICKS = 44
const RESTS_AT = 39
/** A demo tick stands for this long on the line of what ran at once, so a whole run fits it. */
const TICK_MS = 15_000

/** The probes the invented researcher sends out: what each asks, and the ticks it starts and ends at. */
const QUESTIONS = [
  { label: 'Cycle life by battery chemistry', from: 6, to: 17 },
  { label: 'Capacity loss in field studies', from: 6, to: 21 },
  { label: 'How heat and cold change ageing', from: 7, to: 14 },
  { label: 'What warranties promise', from: 7, to: 18, isFailed: true },
  { label: 'Recycling and second life', from: 8, to: 23 },
  { label: 'Cost per stored kWh over the years', from: 15, to: 27 },
  { label: 'What warranties promise, again', from: 19, to: 28 },
]

/** Invented domains under the name reserved for examples. */
const DOMAINS = [
  'cell-journal', 'grid-stats', 'ev-forum', 'chem-review', 'lab-notes', 'energy-wiki', 'field-data', 'warranty-db',
  'recycle-hub', 'cold-test', 'solar-guide', 'preprints', 'standards', 'market-watch', 'home-power', 'tech-press',
  'consumer-test', 'utility-report', 'materials', 'open-data', 'engineering', 'video-talks', 'news-daily', 'gov-energy',
  'uni-press', 'patents', 'blog-cells', 'review-site', 'sensors', 'insurers',
].map(name => `${name}.example`)

const probeLoad = (i: number, t: number) => 1 + ((t * 7 + i * 3) % 4)

/** The researcher's own searches and reads at a tick: while it plans and while it checks. */
function ownLoad(t: number): number {
  if (t === 0) return 1
  if (t >= 3 && t < 6) return [2, 3, 1][t - 3] ?? 0
  if (t >= 29 && t < 35) return [2, 3, 4, 2, 1, 2][t - 29] ?? 0

  return 0
}

const loadAt = (t: number) =>
  ownLoad(t) + QUESTIONS.reduce((sum, q, i) => sum + (t >= q.from && t < q.to ? probeLoad(i, t) : 0), 0)

/** How many domains have turned up by a tick. */
const foundBy = (t: number) => Math.max(0, Math.min(DOMAINS.length, Math.round(t * 0.95) - 2))

/**
 * One invented agent researching a topic: it asks the person first, sends
 * out probes, five at a time at most, that start, search and finish (one
 * fails and is sent again), checks what came back and writes the report,
 * while the sources pile up.
 */
export function demoResearchSnapshot(tick: number, now: number): Snapshot {
  const t = ((tick % RESEARCH_TICKS) + RESEARCH_TICKS) % RESEARCH_TICKS
  const phase = PHASES.reduce((at, p, i) => (t >= p[1] ? i : at), 0)
  const isResting = t >= RESTS_AT
  const plan: PlanStep[] = PHASES.map(([text], i) =>
    isResting || i < phase ? { text, status: 'done', doneAt: i + 1 } : i === phase ? { text, status: 'active' } : { text, status: 'pending' },
  )
  const state: AgentState = isResting ? 'idle' : t === 1 || t === 2 ? 'question' : phase === 4 ? 'coding' : 'research'
  const action: Partial<Record<AgentState, string>> = {
    research: phase === 3 ? 'WebFetch https://cell-journal.example/…' : 'WebSearch home battery lifespan',
    question: 'asked a question', coding: 'Write home-batteries.md',
  }
  const probes: ResearchProbe[] = QUESTIONS.flatMap((q, i) => {
    if (t < q.from) return []
    const isRunning = t < q.to
    let calls = 0
    for (let k = q.from; k <= Math.min(t, q.to - 1); k++) calls += probeLoad(i, k) * 2
    const base = { id: `demo-probe-${i + 1}`, label: q.label, inFlight: isRunning ? probeLoad(i, t) : 0, calls, startedAt: now - (t - q.from) * TICK_MS }

    return [isRunning ? { ...base, status: 'running' as const } : { ...base, status: q.isFailed === true ? 'failed' as const : 'done' as const, endedAt: now - (t - q.to) * TICK_MS }]
  })
  const sources: ResearchSource[] = DOMAINS.slice(0, foundBy(t)).map((domain, i) => {
    const since = Array.from({ length: t + 1 }, (_, k) => k).find(k => foundBy(k) > i) ?? t
    const isRead = i % 3 === 0 || (t >= 29 && i % 3 === 1)

    return { domain, hits: Math.min(6, 1 + Math.floor((t - since) / 5)), ...(isRead ? { isRead: true as const } : {}) }
  })
  // What ran at once: each tick holds its level for the time it stands for.
  const tickAt = (time: number) => t - Math.floor((now - time) / TICK_MS)
  const end = Math.floor(now / BUCKET_MS) * BUCKET_MS
  const history: ConcurrencySample[] = []
  for (let j = 0; j < SERIES; j++) {
    const at = end - (SERIES - 1 - j) * BUCKET_MS
    const ticks = [tickAt(at), tickAt(Math.min(now, at + BUCKET_MS - 1))].filter(k => k >= 0)
    const n = Math.max(0, ...ticks.map(loadAt))
    if (n > 0) history.push({ at, n })
  }
  let peak = 0
  let peakTick = 0
  for (let k = 0; k <= t; k++) {
    if (loadAt(k) > peak) [peak, peakTick] = [loadAt(k), k]
  }
  const agent: AgentRecord = {
    v: 1, sessionId: 'demo', isLive: true, id: 'home-batteries', worktree: '/demo/home-batteries', branch: 'research/home-batteries',
    role: 'agent', state, since: now, lastAction: action[state] ?? '', lastActionAt: now, promptAt: t < 3 ? 1 : 2, updatedAt: now,
    plan, mode: 'research',
    research: {
      since: now - t * TICK_MS, inFlight: ownLoad(t), calls: probes.reduce((sum, p) => sum + p.calls, 0) + t * 2, probes, sources,
      history, peak, peakAt: now - (t - peakTick) * TICK_MS,
    },
  }

  return toSnapshot([agent], now, { asleepAfterMs: 1e12 })
}
