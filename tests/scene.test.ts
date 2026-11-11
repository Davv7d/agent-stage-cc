import { expect, test } from 'claude-code/testing'

import type { AgentRecord, AgentState, ResourceView, Snapshot } from '../types'
import { demoSnapshot, demoUsage } from '../hooks/core/demo'
import { toSnapshot } from '../hooks/core/model'
import { langOf } from '../hooks/scene/labels'
import { fitLayout } from '../hooks/scene/layout'
import { neon } from '../hooks/scene/neon'
import { MAX_SOURCE, renderScene, shorten } from '../hooks/scene/scene'
import { colorOf } from '../hooks/scene/skin'
import { advance, USAGE_REDRAW_MS, WORK_SLOTS } from '../hooks/scene/stage'

const OPTIONS = { lang: 'en' as const, focus: false, labels: true, links: true, utcOffsetMinutes: 0 }

const agent = (id: string, state: AgentState, more: Partial<AgentRecord> = {}): AgentRecord => ({
  v: 1, id, worktree: `/w/${id}`, branch: null, sessionId: 's', isLive: true, role: 'agent',
  state, since: 0, lastAction: '', lastActionAt: 0, promptAt: 0, updatedAt: 0, ...more,
})
const shot = (...records: AgentRecord[]): Snapshot => toSnapshot(records, 0, { asleepAfterMs: 1e12 })
const stack = (more: Partial<ResourceView> = {}): ResourceView => ({
  v: 1, name: 'stack', holder: null, heldSince: 0, releasedAt: 0, queue: [], members: [], baseline: {},
  updatedAt: 0, swapped: [], phase: 'free', isUrgent: false, isStale: false, ...more,
})
const shotWith = (resource: ResourceView, ...records: AgentRecord[]): Snapshot =>
  toSnapshot(records, 0, { asleepAfterMs: 1e12 }, [resource])
// A docked pane measured 54 columns by 46 rows; a maximised one is wide.
const fitFor = (columns: number, hasRing = false) => fitLayout(columns, columns >= 120 ? 40 : 46, hasRing)
const draw = (stage: ReturnType<typeof advance>, columns = 140) => {
  const { layout, pixelWidth, pixelHeight } = fitFor(columns, stage.resource !== null)

  return renderScene(stage, layout, neon, { ...OPTIONS, pixelWidth, pixelHeight })
}

test('an agent keeps its place while it stays in a zone', async () => {
  let stage = advance(null, shot(agent('a', 'coding'), agent('b', 'coding'), agent('c', 'coding')))
  expect(stage.slots.work.slice(0, 3)).toEqual(['a', 'b', 'c'])
  stage = advance(stage, shot(agent('b', 'research'), agent('c', 'pr'), agent('d', 'coding')))
  // b did not move up into a's place; d took the first free one.
  expect(stage.slots.work.slice(0, 3)).toEqual(['d', 'b', null])
  expect(stage.slots.pr[0]).toBe('c')
})

test('nothing a person would see changed: the stage is the same object', async () => {
  const one = advance(null, shot(agent('a', 'coding', { lastAction: 'Edit x.ts' })))
  const two = advance(one, shot(agent('a', 'coding', { lastAction: 'Edit y.ts', updatedAt: 9 })))
  expect(two).toBe(one)
  expect(advance(two, shot(agent('a', 'testing')))).not.toBe(one)
})

test('an agent that changes zone is carried there, not jumped', async () => {
  let stage = advance(null, shot(agent('a', 'coding')))
  expect(draw(stage)).not.toContain('animateTransform attributeName="transform" type="translate"')
  stage = advance(stage, shot(agent('a', 'pr')))
  const { layout } = fitFor(140)
  const [from, to] = [layout.work(0), layout.pr(0)]
  expect(draw(stage)).toContain(`type="translate" from="${from[0]} ${from[1]}" to="${to[0]} ${to[1]}"`)
})

test('a question sends a pink spark to the coordinator, an answer a white one back', async () => {
  const lead = agent('lead', 'idle', { role: 'coordinator' })
  let stage = advance(null, shot(lead, agent('a', 'coding')))
  stage = advance(stage, shot(lead, agent('a', 'question')))
  expect(stage.sparks).toEqual([{ agent: 'a', kind: 'ask' }])
  expect(draw(stage)).toContain('waiting on you: 1')
  stage = advance(stage, shot(lead, agent('a', 'research', { promptAt: 5 })))
  expect(stage.sparks).toEqual([{ agent: 'a', kind: 'order' }])
  expect(draw(stage)).toContain('fill="#ffffff"')
})

test('without a coordinator there is no coordinator zone and no links', async () => {
  const svg = draw(advance(null, shot(agent('solo', 'coding'))))
  expect(svg).not.toContain('COORDINATOR')
  expect(svg).not.toContain('<line')
  expect(svg).toContain('solo')
})

test('names and actions cannot break out of the drawing', async () => {
  const svg = draw(advance(null, shot(agent('a', 'coding', { lastAction: '$ echo "</svg><script>x</script>" & <b>', branch: 'x<y' }))))
  expect(svg).not.toContain('<script')
  expect(svg).not.toContain('<b>')
  expect(svg.match(/<\/svg>/g)?.length).toBe(1)
})

test('a full stage fits the element, in both layouts, and overflow is counted', async () => {
  const many = Array.from({ length: WORK_SLOTS + 3 }, (_, i) =>
    agent(`a-very-long-worktree-name-number-${String(i).padStart(2, '0')}`, 'question', { lastAction: 'x'.repeat(60) }),
  )
  const stage = advance(null, shot(...many))
  for (const columns of [60, 140]) {
    const svg = draw(stage, columns)
    expect(svg.length).toBeLessThan(MAX_SOURCE)
    expect(svg).toContain('+3 more')
  }
})

test('the layout follows the pane, the language follows the machine', async () => {
  expect(fitLayout(54, 46).layout.kind).toBe('narrow')
  expect(fitLayout(91, 46).layout.kind).toBe('narrow')
  expect(fitLayout(140, 40).layout.kind).toBe('wide')
  expect(langOf('pl_PL.UTF-8')).toBe('pl')
  expect(langOf('en_US.UTF-8')).toBe('en')
  expect(langOf(undefined)).toBe('en')
})

test('the drawing takes the whole pane, whatever its shape', async () => {
  // Apart as grid cells are, or as far as neighbours on the queue's arc.
  const rects = (a: readonly [number, number], b: readonly [number, number]) =>
    Math.abs(a[0] - b[0]) >= 60 || Math.abs(a[1] - b[1]) >= 55 || Math.hypot(a[0] - b[0], a[1] - b[1]) >= 65
  // Docked, widened, maximised, short and wide, tall and thin.
  const shapes = [[54, 46], [91, 46], [140, 40], [200, 34], [120, 60], [60, 70]] as const
  for (const hasRing of [false, true]) {
    for (const [columns, rows] of shapes) {
      const fit = fitLayout(columns, rows, hasRing)
      expect(fit.pixelWidth).toBe(columns * 8)
      expect(fit.pixelHeight).toBe(rows * 20 - 44)
      // The drawing has the pane's own proportions, so nothing is left empty.
      expect(Math.abs(fit.layout.width / fit.layout.height - fit.pixelWidth / fit.pixelHeight)).toBeLessThan(0.01)
      const { layout } = fit
      expect(layout.ring !== undefined).toBe(hasRing)
      const places = [
        layout.coordinator,
        ...Array.from({ length: 15 }, (_, i) => layout.work(i)),
        ...Array.from({ length: 5 }, (_, i) => layout.pr(i)),
        ...(layout.ring === undefined ? [] : [layout.ring.center, ...Array.from({ length: 6 }, (_, i) => layout.ring!.queue(i))]),
      ]
      places.forEach((at, i) => {
        // Every place is inside the drawing, with room for its name and state.
        expect(at[0]).toBeGreaterThan(30)
        expect(at[0]).toBeLessThan(layout.width - 30)
        expect(at[1]).toBeGreaterThan(60)
        expect(at[1]).toBeLessThan(layout.height - 50)
        // And no two places sit on top of each other.
        for (const other of places.slice(i + 1)) expect(rects(at, other)).toBe(true)
      })
    }
  }
  // The pane measured when widened: three columns no longer leave a gap.
  expect(fitLayout(91, 46).pixelWidth).toBe(728)
})

test('a pane too small for the scene still gets a whole one, to scroll', async () => {
  const fit = fitLayout(30, 12)
  expect(fit.layout.kind).toBe('narrow')
  expect(fit.pixelWidth).toBe(240)
  expect(fit.pixelHeight).toBeGreaterThan(240)
})

test('colors are stable per name and never the reserved pink or red', async () => {
  expect(colorOf('billing-export')).toBe(colorOf('billing-export'))
  for (const id of ['a', 'b', 'login', 'x-1', 'audit-log', 'zzz']) {
    expect(['#ff5fa2', '#ff6b6b']).not.toContain(colorOf(id))
  }
  expect(shorten('abcdefghijklmnopqrstuvwxyz', 11)).toBe('abcde…vwxyz')
})

test('the demo team walks through every state and always draws', async () => {
  const seen = new Set<string>()
  let stage = advance(null, demoSnapshot(0, 0))
  for (let step = 1; step < 120; step++) {
    stage = advance(stage, demoSnapshot(step, 0))
    for (const a of stage.agents) seen.add(a.state)
    expect(draw(stage, step % 2 ? 60 : 140).length).toBeLessThan(MAX_SOURCE)
  }
  expect([...seen].sort()).toEqual(['coding', 'done', 'pr', 'question', 'queue', 'research', 'testing'])
})

test('the holder stands in the ring and the queue lines up beside it', async () => {
  const lead = agent('lead', 'idle', { role: 'coordinator' })
  const res = stack({ holder: 'a', phase: 'held', queue: ['b', 'c'], members: ['db', 'api', 'web'], swapped: ['api'] })
  const stage = advance(null, shotWith(res, lead, agent('a', 'testing'), agent('b', 'coding'), agent('c', 'question'), agent('d', 'coding')))
  expect(stage.places).toEqual({
    a: { zone: 'holder', index: 0 },
    b: { zone: 'queue', index: 0 },
    c: { zone: 'queue', index: 1 },
    d: { zone: 'work', index: 0 },
  })
  // Waiting shows as the queue state, unless the agent needs the person.
  expect(stage.agents.map(a => a.state)).toEqual(['testing', 'queue', 'question', 'coding'])
  const svg = draw(stage)
  expect(svg).toContain('STACK')
  expect(svg).toContain('<title>api</title>')
  expect(svg).toContain('stack: a · queue 2')
  expect(svg).toContain('>#1<')
  // One segment per container, the swapped one in the holder's color.
  expect(svg.match(/<title>/g)?.length).toBe(3)
  expect(svg).toContain(`fill="${colorOf('a')}"><title>api</title>`)
})

test('a granted agent is carried from the queue into the ring', async () => {
  const before = stack({ holder: 'a', phase: 'held', queue: ['b'] })
  let stage = advance(null, shotWith(before, agent('a', 'testing'), agent('b', 'coding')))
  stage = advance(stage, shotWith(stack({ holder: 'b', phase: 'held' }), agent('a', 'coding'), agent('b', 'testing')))
  const { layout } = fitFor(140, true)
  const [from, to] = [layout.ring!.queue(0), layout.ring!.center]
  expect(draw(stage)).toContain(`from="${from[0]} ${from[1]}" to="${to[0]} ${to[1]}"`)
})

test('a free ring says so, a restoring or blocked one is marked', async () => {
  expect(draw(advance(null, shotWith(stack(), agent('a', 'coding'))))).toContain('>free<')
  expect(draw(advance(null, shotWith(stack({ phase: 'restoring', swapped: ['x'], members: ['x'] }), agent('a', 'coding'))))).toContain('>restoring<')
  const urgent = draw(advance(null, shotWith(stack({ holder: 'a', phase: 'held', queue: ['b'], isUrgent: true }), agent('a', 'question'), agent('b', 'coding'))))
  expect(urgent).toContain('urgent: blocks the queue')
  expect(draw(advance(null, shot(agent('a', 'coding'))))).not.toContain('STACK')
})

const GB = 1024 ** 3
const cost = (cpu: number, ram: number) => ({ agents: { a: { cpu, ramBytes: ram * GB } }, containers: {}, machine: { cores: 8, ramBytes: 32 * GB } })

test('exact figures go to the hover card, coarse steps to the drawing', async () => {
  const stage = advance(null, shot(agent('a', 'coding')), cost(80, 2), 1000)
  const svg = draw(stage)
  expect(svg).toContain('CPU 10% · RAM 2.0 GB')
  // A CPU arc round the ball, a memory bar under the name, meters for the whole.
  expect(svg).toContain('A21 21 0 1 1')
  expect(svg).toContain('width="30" height="3"')
  expect(svg).toContain('>2 / 32 GB<')
  // A quiet agent gets neither arc nor bar.
  const quiet = draw(advance(null, shot(agent('a', 'idle')), cost(1, 0.1), 1000))
  expect(quiet).not.toContain('A21 21')
  expect(quiet).not.toContain('height="3"')
})

test('a wobbling number cannot flicker the scene', async () => {
  const one = advance(null, shot(agent('a', 'coding')), cost(80, 2), 1000)
  // The same step: nothing new. A new step too soon: still nothing new.
  expect(advance(one, shot(agent('a', 'coding')), cost(90, 2.1), 2000)).toBe(one)
  expect(advance(one, shot(agent('a', 'coding')), cost(400, 2), 5000)).toBe(one)
  // Once the quiet time has passed, the new step is drawn.
  const later = advance(one, shot(agent('a', 'coding')), cost(400, 2), 1000 + USAGE_REDRAW_MS)
  expect(later).not.toBe(one)
  expect(later.levels?.agents.a?.cpu).toBe(3)
  // A change of state redraws at once and takes the fresh steps along.
  const moved = advance(one, shot(agent('a', 'testing')), cost(400, 2), 5000)
  expect(moved.levels?.agents.a?.cpu).toBe(3)
})

test('a container under load shows on the rim of its segment', async () => {
  const res = stack({ holder: 'a', phase: 'held', members: ['db', 'api'] })
  const usage = { agents: {}, containers: { db: { cpu: 0, ramBytes: GB }, api: { cpu: 300, ramBytes: GB } }, machine: { cores: 8, ramBytes: 32 * GB } }
  const svg = draw(advance(null, shotWith(res, agent('a', 'testing')), usage, 1000))
  expect(svg.match(/A87 87/g)?.length).toBe(1)
})

test('the demo team has figures of its own', async () => {
  const shot = demoSnapshot(40, 0)
  const usage = demoUsage(shot)
  expect(Object.keys(usage.agents).length).toBe(shot.agents.length)
  expect(Object.keys(usage.containers).length).toBe(20)
  expect(draw(advance(null, shot, usage), 54)).toContain('CPU ')
})

test('a stage stored by an earlier version still draws', async () => {
  const stage = advance(null, shot(agent('a', 'coding')))
  const { levels: _later, levelsAt: _when, ...older } = stage
  expect(draw(older as typeof stage)).toContain('>a<')
})
