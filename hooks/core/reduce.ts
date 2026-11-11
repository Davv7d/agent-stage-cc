import type { AgentRecord, AgentState } from '../../types'
import { endsWithQuestion, findPrUrl } from './derive'
import type { Action } from './derive'
import { isFinished, planAfter } from './plan'

export type StageEvent =
  | { kind: 'session-start'; at: number; sessionId: string }
  | { kind: 'session-end'; at: number }
  | { kind: 'turn-start'; at: number }
  | { kind: 'tool-start'; at: number; action: Action }
  | { kind: 'tool-end'; at: number; action: Action; isError: boolean; output?: string }
  /** A call of a tool that keeps the agent's task list, once it succeeded. */
  | { kind: 'plan-call'; at: number; tool: string; input: Readonly<Record<string, unknown>>; result?: unknown }
  /** The person turned a working mode on, or off with null. */
  | { kind: 'mode'; at: number; name: string | null; role?: 'coordinator' }
  /** What the forge says of the agent's pull request, asked now and then. */
  | { kind: 'pr-state'; at: number; state: 'open' | 'merged' | 'closed'; url?: string }
  | { kind: 'turn-end'; at: number; answer: string; reason: 'answer' | 'aborted' | 'refusal' | 'error' }

const enter = (rec: AgentRecord, state: AgentState, at: number): AgentRecord =>
  rec.state === state ? rec : { ...rec, state, since: at }

/** Where an agent rests between turns: on its open PR, else idle. */
const rest = (rec: AgentRecord): AgentState => (rec.pr ? 'pr' : 'idle')

function onToolStart(rec: AgentRecord, at: number, action: Action): AgentRecord {
  const acted = { ...rec, lastAction: action.label, lastActionAt: at }

  switch (action.kind) {
    case 'research':
      // Looking around does not take an agent off its open PR.
      return rec.state === 'pr' ? acted : enter(acted, 'research', at)
    case 'coding':
      return enter(acted, 'coding', at)
    case 'test':
      return enter(acted, 'testing', at)
    case 'ask':
      return enter({ ...acted, before: rec.state === 'question' ? rec.before : rec.state }, 'question', at)
    case 'coordinate': {
      // Handing work out makes a coordinator in its own right, whatever a mode said.
      const { isRoleFromMode: _lent, ...own } = acted

      return { ...own, role: 'coordinator' }
    }
    default:
      return acted
  }
}

function onToolEnd(
  rec: AgentRecord,
  at: number,
  action: Action,
  isError: boolean,
  output: string,
): AgentRecord {
  switch (action.kind) {
    case 'test':
      return isError && rec.state === 'testing' ? enter(rec, 'failed', at) : rec
    case 'ask': {
      const { before, ...answered } = rec

      return rec.state === 'question' ? enter(answered, before ?? 'research', at) : rec
    }
    case 'pr-create': {
      // `gh pr create` answers with the pull request's address; without one
      // nothing was opened.
      const url = isError ? undefined : findPrUrl(output)

      return url === undefined ? rec : enter({ ...rec, pr: { url } }, 'pr', at)
    }
    case 'pr-merge': {
      if (isError) return rec
      const { pr: _merged, ...merged } = rec

      return enter(merged, 'done', at)
    }
    default:
      return rec
  }
}

function onTurnEnd(rec: AgentRecord, at: number, answer: string, reason: string): AgentRecord {
  if (rec.state === 'done') return rec
  // Failed tests the agent walked away from still want the person.
  if (rec.state === 'failed') return rec
  if (reason === 'answer' && endsWithQuestion(answer)) {
    return enter({ ...rec, before: rest(rec) }, 'question', at)
  }

  return enter(rec, rest(rec), at)
}

/** A record with its mode gone, and with it a role only the mode had given. */
function withoutMode(rec: AgentRecord): AgentRecord {
  const { mode: _was, isRoleFromMode, ...rest } = rec

  return isRoleFromMode === true ? { ...rest, role: 'agent' } : rest
}

/** One event applied to one agent's record: pure, so every rule is testable. */
export function apply(rec: AgentRecord, event: StageEvent): AgentRecord {
  const next = step(rec, event)

  return { ...next, updatedAt: event.at }
}

function step(rec: AgentRecord, event: StageEvent): AgentRecord {
  switch (event.kind) {
    case 'session-start': {
      if (event.sessionId === rec.sessionId) return { ...rec, isLive: true }
      // Another session in the same worktree: the plan and the mode were the last one's.
      const { plan: _plan, ...fresh } = withoutMode(rec)

      return { ...fresh, sessionId: event.sessionId, isLive: true }
    }
    case 'session-end':
      return { ...rec, isLive: false }
    case 'mode': {
      const rest = withoutMode(rec)
      if (event.name === null) return rest
      if (event.role === undefined || rest.role === event.role) return { ...rest, mode: event.name }

      return { ...rest, mode: event.name, role: event.role, isRoleFromMode: true }
    }
    case 'plan-call': {
      const plan = planAfter(rec.plan, event.tool, event.input, event.result, event.at)
      const { plan: _was, ...rest } = rec

      return plan.length === 0 ? rest : { ...rest, plan }
    }
    case 'turn-start': {
      // A new order after a finished plan starts from an empty one.
      const { before: _answered, plan, ...fresh } = { ...rec, promptAt: event.at }
      const prompted = plan === undefined || isFinished(plan) ? fresh : { ...fresh, plan }
      const wakes = rec.state === 'idle' || rec.state === 'question' || rec.state === 'failed' || rec.state === 'done'

      return wakes ? enter(prompted, 'research', event.at) : prompted
    }
    case 'tool-start':
      return onToolStart(rec, event.at, event.action)
    case 'tool-end':
      return onToolEnd(rec, event.at, event.action, event.isError, event.output ?? '')
    case 'turn-end':
      return onTurnEnd(rec, event.at, event.answer, event.reason)
    case 'pr-state': {
      if (event.state === 'open') {
        return event.url === undefined || rec.pr === undefined ? rec : { ...rec, pr: { url: event.url } }
      }
      if (rec.pr === undefined) return rec
      const { pr: _closed, ...without } = rec
      // Merged: the work is done. Closed unmerged: the agent is back to idle.
      if (event.state === 'merged') return enter(without, 'done', event.at)

      return rec.state === 'pr' ? enter(without, 'idle', event.at) : without
    }
  }
}
