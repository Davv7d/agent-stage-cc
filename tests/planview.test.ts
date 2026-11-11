import { expect, test } from 'claude-code/testing'

import type { AgentRecord, AgentState, PlanStep, Snapshot, Stage } from '../types'
import { demoPlanSnapshot } from '../hooks/core/demo'
import { toSnapshot } from '../hooks/core/model'
import { fitLayout, fitPlan } from '../hooks/scene/layout'
import { neon } from '../hooks/scene/neon'
import { renderPlan } from '../hooks/scene/plan'
import { describeScene, MAX_SOURCE, renderScene } from '../hooks/scene/scene'
import { advance, PLAN_DONE_SLOTS, PLAN_TODO_SLOTS, planAgent } from '../hooks/scene/stage'

const OPTIONS = { lang: 'en' as const, focus: false, labels: true, links: true, utcOffsetMinutes: 0 }

const agent = (id: string, state: AgentState, more: Partial<AgentRecord> = {}): AgentRecord => ({
  v: 1, id, worktree: `/w/${id}`, branch: null, sessionId: 's', isLive: true, role: 'agent',
  state, since: 0, lastAction: '', lastActionAt: 0, promptAt: 0, updatedAt: 0, ...more,
})
const shot = (...records: AgentRecord[]): Snapshot => toSnapshot(records, 0, { asleepAfterMs: 1e12 })
/** A plan from a word of marks: `d` done, `a` in progress, `p` waiting. */
const plan = (marks: string): PlanStep[] =>
  [...marks].map((m, i) => (m === 'd' ? { text: `Step ${i + 1}`, status: 'done', doneAt: i + 1 } : { text: `Step ${i + 1}`, status: m === 'a' ? 'active' : 'pending' }))
const draw = (stage: Stage, columns = 130, rows = 30) => {
  if (stage.plan === null) throw new Error('no plan on show')
  const fit = fitPlan(columns, rows, stage.resource !== null)

  return renderPlan(stage, stage.plan, fit.layout, neon, { ...OPTIONS, pixelWidth: fit.pixelWidth, pixelHeight: fit.pixelHeight })
}

test('left to itself the stage shows a plan when one agent alone keeps one', async () => {
  const solo = shot(agent('a', 'coding', { plan: plan('dap') }))
  expect(planAgent(solo, {}, null)?.id).toBe('a')
  expect(advance(null, solo).plan?.agent.id).toBe('a')
  // An agent without a task list has no plan to show.
  expect(advance(null, shot(agent('a', 'coding'))).plan).toBe(null)
  // More agents in play: the team is the scene.
  const team = shot(agent('a', 'coding', { plan: plan('dap') }), agent('b', 'research'))
  expect(advance(null, team).plan).toBe(null)
  // Others that only sleep do not make a team.
  const asleep = toSnapshot([agent('a', 'coding', { plan: plan('dap'), updatedAt: 100 }), agent('b', 'idle')], 100, { asleepAfterMs: 50 })
  expect(advance(null, asleep).plan?.agent.id).toBe('a')
})

test('a person can hold the pane to the team or to a plan', async () => {
  const team = shot(agent('a', 'coding', { plan: plan('dap') }), agent('b', 'research', { plan: plan('ap') }))
  expect(advance(null, team, null, 0, { view: 'team' }).plan).toBe(null)
  // Asked for a plan, the pane shows its own session's.
  expect(advance(null, team, null, 0, { view: 'plan', self: 'b' }).plan?.agent.id).toBe('b')
  expect(advance(null, team, null, 0, { view: 'plan', self: 'zz' }).plan?.agent.id).toBe('a')
  expect(advance(null, shot(agent('a', 'coding', { plan: plan('dap') })), null, 0, { view: 'team' }).plan).toBe(null)
  // With no plan anywhere the team's scene stands in.
  expect(advance(null, shot(agent('a', 'coding')), null, 0, { view: 'plan', self: 'a' }).plan).toBe(null)
})

test('steps stand in zones by how far they are, the rest are counted', async () => {
  const scene = advance(null, shot(agent('a', 'coding', { plan: plan('ddddddappppppp') }))).plan
  if (scene === null || scene === undefined) throw new Error('no plan')
  const zones = (zone: string) => scene.steps.filter(s => scene.places[s.key]?.zone === zone).map(s => s.ordinal)
  expect(zones('active')).toEqual([7])
  // The next steps wait in order; the latest done stay on show.
  expect(zones('todo')).toEqual([8, 9, 10, 11])
  expect(zones('done')).toEqual([3, 4, 5, 6])
  expect(zones('gate')).toEqual([])
  expect(scene.more).toEqual({ todo: 7 - PLAN_TODO_SLOTS, done: 6 - PLAN_DONE_SLOTS })
  expect(scene.isWaiting).toBe(false)
})

test('a step just done stands at the gate while the agent waits to go on', async () => {
  const working = advance(null, shot(agent('a', 'testing', { plan: plan('dap') })))
  const waiting = advance(working, shot(agent('a', 'idle', { plan: plan('ddp') })))
  expect(waiting.plan?.isWaiting).toBe(true)
  expect(waiting.plan?.places['Step 2']).toEqual({ zone: 'gate', index: 0 })
  expect(waiting.plan?.places['Step 1']).toEqual({ zone: 'done', index: 0 })
  const svg = draw(waiting)
  expect(svg).toContain('waiting for you')
  // Answered, the agent goes on: the step passes the gate and the next begins.
  const onward = advance(waiting, shot(agent('a', 'coding', { plan: plan('dda'), promptAt: 5 })))
  expect(onward.plan?.places['Step 2']).toEqual({ zone: 'done', index: 1 })
  expect(draw(onward)).not.toContain('waiting for you')
  // A run that never stops never shows a gate; nor does a finished plan.
  expect(draw(working)).not.toContain('waiting for you')
  const finished = advance(onward, shot(agent('a', 'idle', { plan: plan('ddd') })))
  expect(finished.plan?.isWaiting).toBe(false)
  expect(Object.values(finished.plan?.places ?? {}).some(p => p.zone === 'gate')).toBe(false)
})

test('a step is carried from its old place to its new one, once', async () => {
  const one = advance(null, shot(agent('a', 'coding', { plan: plan('ap') })))
  expect(draw(one)).not.toContain('type="translate"')
  const two = advance(one, shot(agent('a', 'coding', { plan: plan('da') })))
  const fit = fitPlan(130, 30)
  const from = fit.layout.active(0)
  const to = fit.layout.done(0)
  expect(draw(two)).toContain(`from="${from[0]} ${from[1]}" to="${to[0]} ${to[1]}"`)
  // The same plan again is the same stage: nothing is drawn anew.
  expect(advance(two, shot(agent('a', 'coding', { plan: plan('da') })))).toBe(two)
  // A redraw for another reason does not replay the journey.
  const three = advance(two, shot(agent('a', 'testing', { plan: plan('da') })))
  expect(draw(three)).not.toContain('type="translate"')
})

test('the line to the step in progress is alive only while the agent works', async () => {
  const sparks = (state: AgentState) => (draw(advance(null, shot(agent('a', state, { plan: plan('dap') })))).match(/<animateMotion/g) ?? []).length
  // The testing glyph has a moving point of its own.
  expect(sparks('coding')).toBe(3)
  expect(sparks('testing')).toBe(4)
  expect(sparks('failed')).toBe(0)
  expect(sparks('question')).toBe(0)
  const failed = draw(advance(null, shot(agent('a', 'failed', { plan: plan('dap') }))))
  expect(failed).toContain('stroke="#ff6b6b" stroke-opacity=".35"')
})

test('the plan fits a wide pane and a docked one, and a long plan stays small', async () => {
  const many = plan(`${'d'.repeat(20)}a${'p'.repeat(19)}`).map(s => ({ ...s, text: `${s.text} ${'with a long name '.repeat(6)}`.slice(0, 120) }))
  const stage = advance(null, shot(agent('a', 'coding', { plan: many })))
  for (const [columns, rows] of [[130, 30], [62, 44], [200, 60], [40, 14]] as const) {
    const svg = draw(stage, columns, rows)
    expect(svg.length < MAX_SOURCE / 4).toBe(true)
    const fit = fitPlan(columns, rows)
    for (const at of [fit.layout.agent, fit.layout.todo(3), fit.layout.active(0), fit.layout.gate, fit.layout.done(3)]) {
      expect(at[0] > 20 && at[0] < fit.layout.width - 20 && at[1] > 60 && at[1] < fit.layout.height - 40).toBe(true)
    }
  }
  expect(fitPlan(130, 30).layout.kind).toBe('wide')
  expect(fitPlan(62, 44).layout.kind).toBe('narrow')
  expect(draw(stage)).toContain('step 21 / 40')
  expect(draw(stage)).toContain('+15 more')
  expect(describeScene(stage, 'en')).toBe('a: coding, 20 / 40 done')
})

test('in the team scene an agent with a plan shows how far it is', async () => {
  const stage = advance(null, shot(agent('a', 'coding', { plan: plan('ddap') }), agent('b', 'research')))
  expect(stage.plan).toBe(null)
  const fit = fitLayout(140, 40)
  const svg = renderScene(stage, fit.layout, neon, { ...OPTIONS, pixelWidth: fit.pixelWidth, pixelHeight: fit.pixelHeight })
  expect(svg).toContain('>2/4</text>')
  // The hover card names the steps around the one in progress.
  expect(svg).toContain('>2 / 4 done<')
  expect(svg).toContain('>▸ Step 3<')
  expect(svg.match(/\d\/\d<\/text>/g)?.length).toBe(1)
})

test('the demo agent walks its plan, stops for the person, and finishes', async () => {
  const states = new Set<string>()
  let gates = 0
  let finished = false
  let stage: Stage | null = null
  for (let tick = 0; tick < 30; tick++) {
    stage = advance(stage, demoPlanSnapshot(tick, 0))
    const scene = stage.plan
    if (scene === null) throw new Error('the demo plan is not on show')
    states.add(scene.agent.state)
    if (Object.values(scene.places).some(p => p.zone === 'gate')) gates += 1
    if (scene.steps.every(s => s.status === 'done')) finished = true
    expect(draw(stage).length < MAX_SOURCE).toBe(true)
  }
  expect([...states].sort()).toEqual(['coding', 'idle', 'question', 'research', 'testing'])
  expect(gates > 0).toBe(true)
  expect(finished).toBe(true)
})

test('the agent\'s CPU arc is drawn outside its ball, where it can be seen', async () => {
  const GB = 1024 ** 3
  const usage = { system: { cpuPercent: 40, ramBytes: 8 * GB }, agents: { a: { cpu: 200, ramBytes: 2 * GB } }, containers: {}, machine: { cores: 8, ramBytes: 32 * GB } }
  const svg = draw(advance(null, shot(agent('a', 'testing', { plan: plan('dap') })), usage, 1000))
  // The ball is drawn larger here than in the team's scene, so the arc is wider too.
  expect(svg).toContain('A30 30 0 1 1')
  expect(svg).not.toContain('A21 21')
})

test('a step\'s tip ends where the room does, and drops nothing before that', async () => {
  // Long words wrap wastefully: three rows are full before the text is out.
  const text = 'Rework the-whole-configuration-loader so-that-every-environment-override is-validated-before-the-application writes it'
  const stage = advance(null, shot(agent('a', 'coding', { plan: [{ text, status: 'active' }] })))
  const rows = [...draw(stage).matchAll(/class="t st">([^<]*)<\/text>/g)].map(m => m[1] ?? '')
  const from = rows.findIndex(r => r.startsWith('Rework'))
  const tip = rows.slice(from, from + 3)
  expect(tip.length).toBe(3)
  expect(tip.every(r => r.length <= 40)).toBe(true)
  expect(tip[2]?.endsWith('…')).toBe(true)
  // What is shown is the text's own beginning, word for word.
  expect(text.startsWith(tip.join(' ').replace(/…$/, '').trimEnd())).toBe(true)
})

test('the team\'s scene is not drawn anew for a step nobody can see', async () => {
  const far = (label: string): PlanStep[] => [...plan('dappppp'), { text: label, status: 'pending' }]
  const team = (label: string) => shot(agent('a', 'coding', { plan: far(label) }), agent('b', 'research'))
  const one = advance(null, team('Write the changelog'))
  // A reworded step far down the list changes nothing on show.
  expect(advance(one, team('Write the release notes'))).toBe(one)
  // A step done moves the count beside the agent: that is drawn.
  expect(advance(one, shot(agent('a', 'coding', { plan: plan('ddapppp') }), agent('b', 'research')))).not.toBe(one)
})
