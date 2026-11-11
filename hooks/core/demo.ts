import type { AgentRecord, AgentState, ResourceView, Snapshot, Usage, UsageReport } from '../../types'
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

  return { agents, containers, machine: { cores: 16, ramBytes: 32 * GB } }
}
