import { expect, test } from 'claude-code/testing'

import type { AgentRecord, PlanStep } from '../types'
import { newRecord, mend } from '../hooks/core/model'
import { isFinished, isPlanTool, planAfter, progressOf } from '../hooks/core/plan'
import { apply } from '../hooks/core/reduce'

const words = (plan: readonly PlanStep[]) => plan.map(s => `${s.status}:${s.text}`)

test('a whole list written at once is the plan', async () => {
  const todos = [
    { content: 'Model', status: 'completed', activeForm: 'Modelling' },
    { content: 'Endpoint', status: 'in_progress', activeForm: 'Writing the endpoint' },
    { content: 'Tests', status: 'pending', activeForm: 'Testing' },
  ]
  const plan = planAfter(undefined, 'TodoWrite', { todos }, undefined, 100)
  expect(words(plan)).toEqual(['done:Model', 'active:Endpoint', 'pending:Tests'])
  expect(plan[0]?.doneAt).toBe(100)
  // Written again later, a step keeps the moment it was done.
  const later = planAfter(plan, 'TodoWrite', { todos: [todos[0], { ...todos[1], status: 'completed' }, todos[2]] }, undefined, 200)
  expect(later.map(s => s.doneAt)).toEqual([100, 200, undefined])
  expect(progressOf(later)).toEqual({ done: 2, active: 0, left: 1, total: 3 })
})

test('tasks made and changed one at a time build the same plan', async () => {
  let plan = planAfter(undefined, 'TaskCreate', { subject: 'Model', description: 'x' }, { task: { id: '1', subject: 'Model' } }, 1)
  plan = planAfter(plan, 'TaskCreate', { subject: 'Tests', description: 'y' }, { task: { id: '2', subject: 'Tests' } }, 2)
  plan = planAfter(plan, 'TaskUpdate', { taskId: '1', status: 'in_progress' }, { success: true }, 3)
  expect(words(plan)).toEqual(['active:Model', 'pending:Tests'])
  plan = planAfter(plan, 'TaskUpdate', { taskId: '1', status: 'completed' }, undefined, 4)
  plan = planAfter(plan, 'TaskUpdate', { taskId: '2', subject: 'All tests', status: 'in_progress' }, undefined, 5)
  expect(words(plan)).toEqual(['done:Model', 'active:All tests'])
  // A task removed from the list is no step of the plan.
  expect(words(planAfter(plan, 'TaskUpdate', { taskId: '2', status: 'deleted' }, undefined, 6))).toEqual(['done:Model'])
  // A change to a task the stage never saw made changes nothing.
  expect(planAfter(plan, 'TaskUpdate', { taskId: '9', status: 'completed' }, undefined, 6)).toEqual(plan)
})

test('a host list is read whole, by its next step, and by step numbers', async () => {
  const tool = 'mcp__host__update_plan'
  const items = [
    { content: 'Look around', status: 'in_progress' },
    { content: 'Change it', status: 'pending' },
    { content: 'Check it', status: 'pending' },
  ]
  let plan = planAfter(undefined, tool, { items }, undefined, 1)
  expect(words(plan)).toEqual(['active:Look around', 'pending:Change it', 'pending:Check it'])
  plan = planAfter(plan, tool, { advance: true }, undefined, 2)
  expect(words(plan)).toEqual(['done:Look around', 'active:Change it', 'pending:Check it'])
  plan = planAfter(plan, tool, { done: [2], start: 3 }, undefined, 3)
  expect(words(plan)).toEqual(['done:Look around', 'done:Change it', 'active:Check it'])
  // The closing call checks off what is left.
  plan = planAfter(plan, 'mcp__host__wrap_up', { recap: 'All done.' }, undefined, 4)
  expect(isFinished(plan)).toBe(true)
  expect(plan[2]?.doneAt).toBe(4)
})

test('only task-list tools are read, and a plan is never a wall of text', async () => {
  expect(['TodoWrite', 'TaskCreate', 'TaskUpdate', 'mcp__a__update_plan', 'mcp__a__wrap_up'].every(isPlanTool)).toBe(true)
  expect(['Bash', 'Edit', 'TaskStop', 'TaskList', 'mcp__a__plan'].some(isPlanTool)).toBe(false)
  const plan: PlanStep[] = [{ text: 'One', status: 'active' }]
  expect(planAfter(plan, 'Bash', { command: 'ls' }, undefined, 1)).toEqual(plan)
  const long = planAfter(undefined, 'TodoWrite', { todos: [{ content: `Step\n  ${'x'.repeat(500)}`, status: 'pending' }] }, undefined, 1)
  expect(long[0]?.text.length).toBe(120)
  expect(long[0]?.text.startsWith('Step x')).toBe(true)
  const many = Array.from({ length: 80 }, (_, i) => ({ content: `Step ${i}`, status: 'pending' }))
  expect(planAfter(undefined, 'TodoWrite', { todos: many }, undefined, 1).length).toBe(40)
  // Nothing of a list that is not one.
  expect(planAfter(plan, 'TodoWrite', { todos: 'none' }, undefined, 1)).toEqual(plan)
})

const fresh = (): AgentRecord =>
  newRecord({ id: 'a', worktree: '/repo/wt/a', branch: 'feat/a', stateDir: '/repo/.git/agent-stage-cc' }, 's', 0)

test('the plan rides in the agent record and ends with the work', async () => {
  const todos = [{ content: 'One', status: 'in_progress' }, { content: 'Two', status: 'pending' }]
  let rec = apply(fresh(), { kind: 'plan-call', at: 10, tool: 'TodoWrite', input: { todos } })
  expect(rec.plan?.map(s => s.status)).toEqual(['active', 'pending'])
  // An unfinished plan lasts over turns: step by step is many turns.
  rec = apply(apply(rec, { kind: 'turn-end', at: 20, answer: 'Step one is done.', reason: 'answer' }), { kind: 'turn-start', at: 30 })
  expect(rec.plan?.length).toBe(2)
  const done = todos.map(t => ({ ...t, status: 'completed' }))
  rec = apply(rec, { kind: 'plan-call', at: 40, tool: 'TodoWrite', input: { todos: done } })
  expect(isFinished(rec.plan)).toBe(true)
  // The finished plan stays on show until the next order.
  rec = apply(rec, { kind: 'turn-end', at: 50, answer: 'Done.', reason: 'answer' })
  expect(rec.plan?.length).toBe(2)
  expect(apply(rec, { kind: 'turn-start', at: 60 }).plan).toBe(undefined)
  // An emptied list is no plan at all.
  expect(apply(rec, { kind: 'plan-call', at: 70, tool: 'TodoWrite', input: { todos: [] } }).plan).toBe(undefined)
})

test('a stored plan that is not a list of steps is dropped on reading', async () => {
  const stored = { ...fresh(), plan: [{ text: 'One', status: 'done' }, { nope: true }, 'x'] } as unknown as AgentRecord
  expect(mend(stored).plan).toEqual([{ text: 'One', status: 'done' }])
  expect(mend({ ...fresh(), plan: 'soon' } as unknown as AgentRecord).plan).toBe(undefined)
})

test('a new session in the same worktree starts without the last one\'s plan and mode', async () => {
  const todos = [{ content: 'One', status: 'in_progress' }, { content: 'Two', status: 'pending' }]
  let rec = apply(fresh(), { kind: 'plan-call', at: 10, tool: 'TodoWrite', input: { todos } })
  rec = apply(rec, { kind: 'mode', at: 11, name: 'plan' })
  // The same session coming back (a reload, a resume) keeps both.
  const same = apply(rec, { kind: 'session-start', at: 20, sessionId: rec.sessionId })
  expect(same.plan?.length).toBe(2)
  expect(same.mode).toBe('plan')
  const next = apply(rec, { kind: 'session-start', at: 20, sessionId: 'another' })
  expect(next.plan).toBe(undefined)
  expect(next.mode).toBe(undefined)
  expect(next.sessionId).toBe('another')
})

test('a role a mode gave leaves with the mode; a role earned stays', async () => {
  let rec = apply(fresh(), { kind: 'mode', at: 1, name: 'coordinate', role: 'coordinator' })
  expect([rec.role, rec.mode]).toEqual(['coordinator', 'coordinate'])
  // Another mode, or none: the session is an agent again.
  expect(apply(rec, { kind: 'mode', at: 2, name: 'plan' }).role).toBe('agent')
  expect(apply(rec, { kind: 'mode', at: 2, name: null }).role).toBe('agent')
  expect(apply(rec, { kind: 'session-start', at: 2, sessionId: 'another' }).role).toBe('agent')
  // Once it has handed work out it coordinates in its own right.
  rec = apply(rec, { kind: 'tool-start', at: 3, action: { kind: 'coordinate', label: 'Task A' } })
  expect(apply(rec, { kind: 'mode', at: 4, name: null }).role).toBe('coordinator')
  // A session that already coordinated is not demoted by a mode's coming and going.
  let lead = apply(fresh(), { kind: 'tool-start', at: 1, action: { kind: 'coordinate', label: 'Task A' } })
  lead = apply(lead, { kind: 'mode', at: 2, name: 'coordinate', role: 'coordinator' })
  expect(apply(lead, { kind: 'mode', at: 3, name: null }).role).toBe('coordinator')
})

test('another server\'s tool of the same name is not the agent\'s list', async () => {
  const plan: PlanStep[] = [{ text: 'One', status: 'active' }, { text: 'Two', status: 'pending' }]
  // Tickets, not a task list: states the list does not have.
  const tickets = { items: [{ content: 'BUG-1', status: 'open' }, { content: 'BUG-2', status: 'closed' }] }
  expect(planAfter(plan, 'mcp__tracker__update_plan', tickets, undefined, 5)).toEqual(plan)
  expect(planAfter(plan, 'mcp__tracker__update_plan', { plan: 'Q3 roadmap' }, undefined, 5)).toEqual(plan)
  // A closing call says how the turn went; anything else of that name is something else.
  const last: PlanStep[] = [{ text: 'One', status: 'active' }]
  expect(planAfter(last, 'mcp__other__wrap_up', { session: 7 }, undefined, 5)).toEqual(last)
  expect(planAfter(last, 'mcp__host__wrap_up', { recap: 'Done.' }, undefined, 5)[0]?.status).toBe('done')
})
