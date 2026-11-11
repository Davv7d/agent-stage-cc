import type { PlanStep, PlanStepStatus } from '../../types'

// An agent's plan, read from the task list it already keeps. Claude Code has
// more than one tool for that list; each is read here into the same steps.
// Nothing of a project is known: only steps and how far each has come.

const WHOLE_LIST = /^TodoWrite$/
const ONE_NEW = /^TaskCreate$/
const ONE_CHANGED = /^TaskUpdate$/
/** A host's own list: the whole plan at once, or the next step, or steps by number. */
const HOST_LIST = /(^|__)update_plan$/
/** A host's closing call: the turn is over, and with it a list that has nothing left to begin. */
const HOST_CLOSE = /(^|__)wrap_up$/

/** Whether a tool keeps the agent's task list. */
export const isPlanTool = (tool: string) =>
  [WHOLE_LIST, ONE_NEW, ONE_CHANGED, HOST_LIST, HOST_CLOSE].some(p => p.test(tool))

/**
 * Whether a call writes the session's own list when a subagent makes it.
 * Tasks made and changed one at a time are the session's; a list a subagent
 * writes whole is its own, and is not the plan.
 */
export const isSessionList = (tool: string) => ONE_NEW.test(tool) || ONE_CHANGED.test(tool)

const LIST_STATUS = new Set(['pending', 'in_progress', 'completed'])

/**
 * Whether a call of a tool named as a host's list is one: another server may
 * use the same name for something else. A list's items each carry a text and
 * one of the three states; its closing call carries a recap.
 */
function isHostCall(tool: string, input: Readonly<Record<string, unknown>>): boolean {
  if (HOST_CLOSE.test(tool)) return typeof input.recap === 'string'
  if (!Array.isArray(input.items)) return input.advance === true || Array.isArray(input.done) || typeof input.start === 'number'

  return input.items.every(i => typeof record(i).content === 'string' && LIST_STATUS.has(String(record(i).status)))
}

/** No plan is a wall of text: a step is shown by its first words. */
const MAX_STEPS = 40
const MAX_TEXT = 120

const text = (value: unknown) => (typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT) : '')
const record = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}

const STATUS: Record<string, PlanStepStatus> = {
  pending: 'pending', in_progress: 'active', completed: 'done', active: 'active', done: 'done',
}

const numbers = (value: unknown): number[] =>
  Array.isArray(value) ? value.filter((n): n is number => typeof n === 'number' && Number.isInteger(n)) : []

/** A step in a new status: the moment it was done is kept, to tell the latest. */
function turned(step: PlanStep, status: PlanStepStatus, at: number): PlanStep {
  if (step.status === status) return step
  const { doneAt: _was, ...rest } = step

  return status === 'done' ? { ...rest, status, doneAt: at } : { ...rest, status }
}

/** A whole list as written, each step keeping when it was done before. */
function whole(prev: readonly PlanStep[], items: unknown, at: number): PlanStep[] {
  if (!Array.isArray(items)) return [...prev]
  const before = [...prev]
  const steps: PlanStep[] = []
  for (const item of items.slice(0, MAX_STEPS)) {
    const raw = record(item)
    const words = text(raw.content) || text(raw.subject) || text(raw.text)
    const status = STATUS[String(raw.status)] ?? 'pending'
    if (words === '') continue
    const same = before.findIndex(s => s.text === words)
    const old = same < 0 ? undefined : before.splice(same, 1)[0]
    steps.push(turned({ ...(old ?? { text: words, status: 'pending' }), text: words }, status, at))
  }

  return steps
}

/** The step in progress done, and the next one waiting begun. */
function advanced(prev: readonly PlanStep[], at: number): PlanStep[] {
  const steps = prev.map(s => (s.status === 'active' ? turned(s, 'done', at) : s))
  const next = steps.findIndex(s => s.status === 'pending')
  if (next >= 0) steps[next] = turned(steps[next] as PlanStep, 'active', at)

  return steps
}

/**
 * The plan after one call of a task-list tool that succeeded. `input` is the
 * call as the agent wrote it, `result` what the tool answered. A tool that is
 * not a task list, or a call that says nothing new, leaves the plan as it was.
 */
export function planAfter(
  prev: readonly PlanStep[] | undefined,
  tool: string,
  input: Readonly<Record<string, unknown>>,
  result: unknown,
  at: number,
): PlanStep[] {
  const was = prev ?? []
  if (WHOLE_LIST.test(tool)) return whole(was, input.todos, at)
  if ((HOST_CLOSE.test(tool) || HOST_LIST.test(tool)) && !isHostCall(tool, input)) return [...was]
  // A plan that goes on over turns keeps its place: steps not yet begun
  // are not done because one turn ended.
  if (HOST_CLOSE.test(tool)) return was.some(s => s.status === 'pending') ? [...was] : was.map(s => turned(s, 'done', at))
  if (HOST_LIST.test(tool)) {
    if (Array.isArray(input.items)) return whole(was, input.items, at)
    let steps = input.advance === true ? advanced(was, at) : [...was]
    // Steps named by number, counted from one.
    for (const n of numbers(input.done)) {
      const step = steps[n - 1]
      if (step !== undefined) steps[n - 1] = turned(step, 'done', at)
    }
    const start = typeof input.start === 'number' ? steps[input.start - 1] : undefined
    if (start !== undefined) {
      steps = steps.map(s => (s === start ? turned(s, 'active', at) : s))
    }

    return steps
  }
  if (ONE_NEW.test(tool)) {
    const words = text(input.subject)
    const id = text(record(record(result).task).id)
    if (words === '' || was.length >= MAX_STEPS) return [...was]

    return [...was, { ...(id === '' ? {} : { id }), text: words, status: 'pending' }]
  }
  if (ONE_CHANGED.test(tool)) {
    const id = text(input.taskId)
    if (input.status === 'deleted') return was.filter(s => s.id !== id)

    return was.map(s => {
      if (s.id === undefined || s.id !== id) return s
      const renamed = text(input.subject) === '' ? s : { ...s, text: text(input.subject) }

      return turned(renamed, STATUS[String(input.status)] ?? s.status, at)
    })
  }

  return [...was]
}

/** A plan with every step done is finished: the next order starts a new one. */
export const isFinished = (plan: readonly PlanStep[] | undefined) =>
  plan !== undefined && plan.length > 0 && plan.every(s => s.status === 'done')

/** How far a plan has come. */
export function progressOf(plan: readonly PlanStep[]): { done: number; active: number; left: number; total: number } {
  const done = plan.filter(s => s.status === 'done').length
  const active = plan.filter(s => s.status === 'active').length

  return { done, active, left: plan.length - done - active, total: plan.length }
}

/**
 * A plan at a glance, as the team's scene shows it beside an agent: how far
 * it is, and the few steps around the one in hand.
 */
export function glance(plan: readonly PlanStep[]): { done: number; total: number; near: { status: PlanStepStatus; text: string }[] } {
  const { done, total } = progressOf(plan)
  const current = plan.findIndex(s => s.status !== 'done')
  const from = Math.max(0, Math.min(plan.length - 4, (current < 0 ? plan.length : current) - 1))

  return { done, total, near: plan.slice(from, from + 4).map(s => ({ status: s.status, text: s.text })) }
}

/** A stored plan made right: anything that is not a list of steps is no plan. */
export function mendPlan(value: unknown): PlanStep[] | undefined {
  if (!Array.isArray(value)) return undefined
  const steps = value.filter(
    (s): s is PlanStep =>
      typeof s === 'object' && s !== null && typeof (s as PlanStep).text === 'string' &&
      ['pending', 'active', 'done'].includes((s as PlanStep).status),
  )

  return steps.length === 0 ? undefined : steps
}
