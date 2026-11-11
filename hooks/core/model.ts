import type {
  AgentRecord,
  AgentState,
  AgentView,
  ResourceView,
  Snapshot,
} from '../../types'

export const STATES = [
  'idle',
  'research',
  'coding',
  'queue',
  'testing',
  'failed',
  'question',
  'pr',
  'done',
] as const satisfies readonly AgentState[]

export const EMPTY: Snapshot = { agents: [], resources: [], coordinators: [], counts: countsOf([]) }

export type Identity = {
  id: string
  worktree: string
  branch: string | null
  /** Where every worktree of the repository keeps the shared state. */
  stateDir: string
}

export function newRecord(who: Identity, sessionId: string, at: number): AgentRecord {
  return {
    v: 1,
    id: who.id,
    worktree: who.worktree,
    branch: who.branch,
    sessionId,
    isLive: true,
    role: 'agent',
    state: 'idle',
    since: at,
    lastAction: '',
    lastActionAt: at,
    promptAt: 0,
    updatedAt: at,
  }
}

export function isAgentRecord(value: unknown): value is AgentRecord {
  if (typeof value !== 'object' || value === null) return false
  const r = value as Record<string, unknown>

  return (
    r.v === 1 &&
    typeof r.id === 'string' &&
    typeof r.worktree === 'string' &&
    typeof r.sessionId === 'string' &&
    typeof r.since === 'number' &&
    typeof r.updatedAt === 'number' &&
    (STATES as readonly unknown[]).includes(r.state)
  )
}

/**
 * A stored record made right: one written by an earlier version may claim an
 * open pull request without its address, which nothing could ever close.
 */
export function mend(rec: AgentRecord): AgentRecord {
  const url: unknown = rec.pr?.url
  if (rec.pr === undefined || typeof url === 'string') return rec
  const { pr: _unknown, ...rest } = rec

  return rest.state === 'pr' ? { ...rest, state: 'idle' } : rest
}

function countsOf(agents: readonly AgentRecord[]): Record<AgentState, number> {
  const counts = Object.fromEntries(STATES.map(s => [s, 0])) as Record<AgentState, number>
  for (const a of agents) counts[a.state] += 1

  return counts
}

export type ViewOptions = { asleepAfterMs: number }

export function toView(rec: AgentRecord, now: number, options: ViewOptions): AgentView {
  const isQuiet = now - rec.updatedAt > options.asleepAfterMs
  const isResting = rec.state === 'idle' || !rec.isLive

  return {
    ...rec,
    isAsleep: isResting && isQuiet && rec.state !== 'question',
    needsAttention: rec.state === 'question' || rec.state === 'failed',
  }
}

export function toSnapshot(
  records: readonly AgentRecord[],
  now: number,
  options: ViewOptions,
  resources: readonly ResourceView[] = [],
): Snapshot {
  const agents = [...records]
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map(r => toView(r, now, options))

  return {
    agents,
    resources: [...resources],
    coordinators: agents.filter(a => a.role === 'coordinator').map(a => a.id),
    counts: countsOf(agents),
  }
}
