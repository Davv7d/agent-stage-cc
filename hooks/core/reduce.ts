import type { AgentRecord, AgentState, Research } from '../../types'
import { endsWithQuestion, findPrUrl } from './derive'
import type { Action } from './derive'
import { isFinished, planAfter } from './plan'
import {
  callEnded,
  callStarted,
  emptyResearch,
  isRunning,
  probeEnded,
  probeStarted,
  sessionEnded,
  turnEnded,
} from './research'
import type { Found } from './research'

/** Where a call ran: a subagent's loop by its id (absent: the session's own), and whether it searches or reads. */
type Loop = { loop?: string; isSearch?: boolean }

export type StageEvent =
  | { kind: 'session-start'; at: number; sessionId: string }
  | { kind: 'session-end'; at: number }
  | { kind: 'turn-start'; at: number }
  | ({ kind: 'tool-start'; at: number; action: Action } & Loop)
  | ({ kind: 'tool-end'; at: number; action: Action; isError: boolean; output?: string; found?: Found[] } & Loop)
  /** A subagent began: at its spawn, with what it was sent for, or at a later turn of its own. */
  | { kind: 'probe-start'; at: number; id: string; label?: string; isBackground?: boolean }
  /** A subagent's own turn ended. */
  | { kind: 'probe-end'; at: number; id: string; reason: 'answer' | 'aborted' | 'refusal' | 'error' }
  /** The session's pane shows its research: keep it from now on. */
  | { kind: 'research-watch'; at: number }
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

/** A record with its research changed, where it keeps any. */
const researched = (rec: AgentRecord, change: (r: Research) => Research): AgentRecord =>
  rec.research === undefined ? rec : { ...rec, research: change(rec.research) }

function step(rec: AgentRecord, event: StageEvent): AgentRecord {
  switch (event.kind) {
    case 'session-start': {
      if (event.sessionId === rec.sessionId) return { ...rec, isLive: true }
      // Another session in the same worktree: the plan, the mode and the research were the last one's.
      const { plan: _plan, research: _research, ...fresh } = withoutMode(rec)

      return { ...fresh, sessionId: event.sessionId, isLive: true }
    }
    case 'session-end':
      return researched({ ...rec, isLive: false }, r => sessionEnded(r, event.at))
    case 'probe-start': {
      // A spawn starts the record of research; a later turn only carries one on.
      const r = rec.research ?? (event.label === undefined ? undefined : emptyResearch(event.at))

      return r === undefined ? rec : { ...rec, research: probeStarted(r, event.at, event.id, event.label, event.isBackground) }
    }
    case 'probe-end':
      return researched(rec, r => probeEnded(r, event.at, event.id, event.reason))
    case 'research-watch':
      return rec.research === undefined ? { ...rec, research: emptyResearch(event.at) } : rec
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
      // A new order after a finished plan starts from an empty one, and so
      // does its research, unless some of it still runs.
      const { before: _answered, plan, ...fresh } = { ...rec, promptAt: event.at }
      const isNewOrder = plan !== undefined && isFinished(plan)
      const prompted = plan === undefined || isNewOrder ? fresh : { ...fresh, plan }
      const anew = isNewOrder && prompted.research !== undefined && !isRunning(prompted.research)
        ? { ...prompted, research: emptyResearch(event.at) }
        : prompted
      const wakes = rec.state === 'idle' || rec.state === 'question' || rec.state === 'failed' || rec.state === 'done'

      return wakes ? enter(anew, 'research', event.at) : anew
    }
    case 'tool-start': {
      const acted = onToolStart(rec, event.at, event.action)

      return event.isSearch === true ? researched(acted, r => callStarted(r, event.at, event.loop)) : acted
    }
    case 'tool-end': {
      const ended = onToolEnd(rec, event.at, event.action, event.isError, event.output ?? '')

      return event.isSearch === true ? researched(ended, r => callEnded(r, event.at, event.loop, event.found)) : ended
    }
    case 'turn-end':
      return researched(onTurnEnd(rec, event.at, event.answer, event.reason), r => turnEnded(r, event.at, event.reason))
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
