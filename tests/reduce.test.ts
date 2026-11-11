import { expect, test } from 'claude-code/testing'

import type { AgentRecord } from '../types'
import type { Action, ActionKind } from '../hooks/core/derive'
import { newRecord, toSnapshot } from '../hooks/core/model'
import { apply } from '../hooks/core/reduce'
import type { StageEvent } from '../hooks/core/reduce'

const WHO = { id: 'billing-export', worktree: '/repo/wt/billing-export', branch: 'b', stateDir: '/repo/.git/agent-stage-cc' }
const fresh = () => newRecord(WHO, 's1', 1000)
const act = (kind: ActionKind): Action => ({ kind, label: kind })
const run = (rec: AgentRecord, events: StageEvent[]) => events.reduce(apply, rec)
const start = (kind: ActionKind, at: number): StageEvent => ({ kind: 'tool-start', at, action: act(kind) })
const end = (kind: ActionKind, at: number, isError = false, output = ''): StageEvent => ({
  kind: 'tool-end', at, action: act(kind), isError, output,
})
const turnEnd = (at: number, answer: string): StageEvent => ({ kind: 'turn-end', at, answer, reason: 'answer' })

test('a prompt wakes an idle agent, reading is research, editing is coding', async () => {
  let rec = run(fresh(), [{ kind: 'turn-start', at: 2000 }])
  expect(rec.state).toBe('research')
  expect(rec.promptAt).toBe(2000)
  rec = run(rec, [start('research', 2100), start('coding', 2200)])
  expect(rec.state).toBe('coding')
  expect(rec.since).toBe(2200)
  expect(rec.lastAction).toBe('coding')
})

test('time in a state counts from when it was entered', async () => {
  const rec = run(fresh(), [start('coding', 2000), start('coding', 3000), start('coding', 4000)])
  expect(rec.since).toBe(2000)
  expect(rec.updatedAt).toBe(4000)
})

test('failed tests are failed, passing tests are not', async () => {
  const failed = run(fresh(), [start('test', 2000), end('test', 2500, true)])
  expect(failed.state).toBe('failed')
  const passed = run(fresh(), [start('test', 2000), end('test', 2500)])
  expect(passed.state).toBe('testing')
  expect(run(failed, [start('coding', 3000)]).state).toBe('coding')
})

test('failed tests stay failed when the turn ends', async () => {
  const rec = run(fresh(), [start('test', 2000), end('test', 2500, true), turnEnd(3000, 'The tests fail.')])
  expect(rec.state).toBe('failed')
})

test('a question asked mid-turn returns to what the agent was doing', async () => {
  let rec = run(fresh(), [start('coding', 2000), start('ask', 2100)])
  expect(rec.state).toBe('question')
  rec = run(rec, [end('ask', 2900)])
  expect(rec.state).toBe('coding')
  expect(rec.before).toBe(undefined)
})

test('a turn that ends on a question waits for the person', async () => {
  let rec = run(fresh(), [start('coding', 2000), turnEnd(3000, 'Which option do you want?')])
  expect(rec.state).toBe('question')
  rec = run(rec, [{ kind: 'turn-start', at: 4000 }])
  expect(rec.state).toBe('research')
  expect(run(fresh(), [start('coding', 2000), turnEnd(3000, 'All done.')]).state).toBe('idle')
})

test('an open PR is where the agent rests until it merges', async () => {
  let rec = run(fresh(), [
    start('pr-create', 2000),
    end('pr-create', 2500, false, 'https://github.com/o/r/pull/7'),
  ])
  expect(rec.state).toBe('pr')
  expect(rec.pr?.url).toBe('https://github.com/o/r/pull/7')
  rec = run(rec, [start('research', 2600)])
  expect(rec.state).toBe('pr')
  rec = run(rec, [start('coding', 2700), turnEnd(2800, 'Fixed the review comments.')])
  expect(rec.state).toBe('pr')
  rec = run(rec, [start('pr-merge', 3000), end('pr-merge', 3100)])
  expect(rec.state).toBe('done')
  expect(rec.pr).toBe(undefined)
})

test('a PR command that failed changes nothing', async () => {
  const rec = run(fresh(), [start('coding', 2000), start('pr-create', 2100), end('pr-create', 2200, true)])
  expect(rec.state).toBe('coding')
  expect(rec.pr).toBe(undefined)
})

test('handing out work makes the session a coordinator', async () => {
  expect(run(fresh(), [start('coordinate', 2000)]).role).toBe('coordinator')
})

test('the snapshot counts states, names coordinators and marks who sleeps', async () => {
  const asking = run(fresh(), [start('ask', 2000)])
  const boss = { ...run(fresh(), [start('coordinate', 2000)]), id: 'main' }
  const old = { ...fresh(), id: 'old-task', isLive: false }
  const shot = toSnapshot([asking, boss, old], 2000 + 3_600_000, { asleepAfterMs: 1_800_000 })
  expect(shot.agents.map(a => a.id)).toEqual(['billing-export', 'main', 'old-task'])
  expect(shot.counts.question).toBe(1)
  expect(shot.coordinators).toEqual(['main'])
  expect(shot.agents[0]?.needsAttention).toBe(true)
  expect(shot.agents[0]?.isAsleep).toBe(false)
  expect(shot.agents[2]?.isAsleep).toBe(true)
})

test('a PR is open only once its address came back', async () => {
  const rec = run(fresh(), [start('coding', 2000), start('pr-create', 2100), end('pr-create', 2200, false, 'done')])
  expect(rec.state).toBe('coding')
  expect(rec.pr).toBe(undefined)
})

test('a merge or a close on the forge reaches the agent', async () => {
  const open = run(fresh(), [start('pr-create', 2000), end('pr-create', 2100, false, 'https://github.com/o/r/pull/7')])
  expect(run(open, [{ kind: 'pr-state', at: 3000, state: 'open', url: 'https://github.com/o/r/pull/7' }]).state).toBe('pr')
  const merged = run(open, [{ kind: 'pr-state', at: 3000, state: 'merged' }])
  expect(merged.state).toBe('done')
  expect(merged.pr).toBe(undefined)
  const closed = run(open, [{ kind: 'pr-state', at: 3000, state: 'closed' }])
  expect(closed.state).toBe('idle')
  expect(closed.pr).toBe(undefined)
  // An agent already back at work stays at work.
  expect(run(open, [start('coding', 2500), { kind: 'pr-state', at: 3000, state: 'closed' }]).state).toBe('coding')
  expect(run(fresh(), [{ kind: 'pr-state', at: 3000, state: 'merged' }]).state).toBe('idle')
})
