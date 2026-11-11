import type { AgentRecord, AgentState, PlanStep, ResourceView, Snapshot, Usage, UsageReport } from '../../types'
import { toSnapshot } from './model'

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
