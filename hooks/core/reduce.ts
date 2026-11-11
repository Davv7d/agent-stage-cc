import type { AgentRecord, AgentState } from '../../types'
import { endsWithQuestion, findPrUrl } from './derive'
import type { Action } from './derive'

export type StageEvent =
  | { kind: 'session-start'; at: number; sessionId: string }
  | { kind: 'session-end'; at: number }
  | { kind: 'turn-start'; at: number }
  | { kind: 'tool-start'; at: number; action: Action }
  | { kind: 'tool-end'; at: number; action: Action; isError: boolean; output?: string }
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
    case 'coordinate':
      return { ...acted, role: 'coordinator' }
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

/** One event applied to one agent's record: pure, so every rule is testable. */
export function apply(rec: AgentRecord, event: StageEvent): AgentRecord {
  const next = step(rec, event)

  return { ...next, updatedAt: event.at }
}

function step(rec: AgentRecord, event: StageEvent): AgentRecord {
  switch (event.kind) {
    case 'session-start':
      return { ...rec, sessionId: event.sessionId, isLive: true }
    case 'session-end':
      return { ...rec, isLive: false }
    case 'turn-start': {
      const { before: _answered, ...prompted } = { ...rec, promptAt: event.at }
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
