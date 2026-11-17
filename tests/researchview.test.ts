import { expect, test } from 'claude-code/testing'

import type { AgentRecord, AgentState, PlanStep, Research, ResearchProbe, Snapshot, Stage } from '../types'
import { demoResearchSnapshot } from '../hooks/core/demo'
import { toSnapshot } from '../hooks/core/model'
import { emptyResearch, MAX_PROBES, MAX_SOURCES } from '../hooks/core/research'
import { plPlural } from '../hooks/scene/labels'
import { fitResearch, LABEL_REACH, ORBIT_PLACES } from '../hooks/scene/layout'
import { neon } from '../hooks/scene/neon'
import { counterText, ranked, renderResearch, researchRows, wrap } from '../hooks/scene/research'
import { describeScene, MAX_SOURCE } from '../hooks/scene/scene'
import { ASK, BAD } from '../hooks/scene/skin'
import { advance, ORBIT_SLOTS, researchAgent } from '../hooks/scene/stage'

const OPTIONS = { lang: 'en' as const, focus: false, labels: true, links: true, utcOffsetMinutes: 0 }

const agent = (id: string, state: AgentState, more: Partial<AgentRecord> = {}): AgentRecord => ({
  v: 1, id, worktree: `/w/${id}`, branch: null, sessionId: 's', isLive: true, role: 'agent',
  state, since: 0, lastAction: '', lastActionAt: 0, promptAt: 0, updatedAt: 0, ...more,
})
const shot = (...records: AgentRecord[]): Snapshot => toSnapshot(records, 0, { asleepAfterMs: 1e12 })
const probe = (id: string, status: ResearchProbe['status'] = 'running', more: Partial<ResearchProbe> = {}): ResearchProbe => ({
  id, label: `Question ${id}`, status, inFlight: status === 'running' ? 2 : 0, calls: 5, startedAt: 0, ...more,
})
const research = (more: Partial<Research> = {}): Research => ({ ...emptyResearch(0), ...more })
const plan = (marks: string): PlanStep[] =>
  [...marks].map((m, i) => ({ text: `Phase ${i + 1}`, status: m === 'd' ? 'done' : m === 'a' ? 'active' : 'pending' }))
const draw = (stage: Stage, columns = 140, rows = 40, lang: 'en' | 'pl' = 'en') => {
  if (stage.research === null || stage.research === undefined) throw new Error('no research on show')
  const fit = fitResearch(columns, rows)

  return renderResearch(stage, stage.research, fit.layout, neon, { ...OPTIONS, lang, pixelWidth: fit.pixelWidth, pixelHeight: fit.pixelHeight })
}

test('left to itself the stage shows research when the one agent in play researches', async () => {
  // In the research mode, before anything runs.
  const moded = shot(agent('a', 'research', { mode: 'research', plan: plan('ap') }))
  expect(advance(null, moded).research?.agent.id).toBe('a')
  // Its research takes the place of its plan.
  expect(advance(null, moded).plan).toBe(null)
  // Any agent with a probe out researches; one whose probes are all back keeps its plan.
  expect(advance(null, shot(agent('a', 'research', { research: research({ probes: [probe('p1')] }) }))).research?.agent.id).toBe('a')
  const back = advance(null, shot(agent('a', 'coding', { plan: plan('ap'), research: research({ probes: [probe('p1', 'done')] }) })))
  expect(back.research).toBe(null)
  expect(back.plan?.agent.id).toBe('a')
  // With more agents in play the team is the scene.
  expect(advance(null, shot(agent('a', 'research', { mode: 'research' }), agent('b', 'coding'))).research).toBe(null)
})

test('a person can hold the pane to the research, or away from it', async () => {
  const both = shot(agent('a', 'coding'), agent('b', 'research', { research: research({ probes: [probe('p1')] }) }))
  // Asked for, the pane shows its own session's research, even before there is any.
  expect(advance(null, both, null, 0, { view: 'research', self: 'a' }).research?.agent.id).toBe('a')
  expect(advance(null, both, null, 0, { view: 'research', self: 'zz' }).research?.agent.id).toBe('b')
  const solo = shot(agent('a', 'research', { mode: 'research', plan: plan('ap') }))
  expect(advance(null, solo, null, 0, { view: 'plan' }).research).toBe(null)
  expect(advance(null, solo, null, 0, { view: 'plan' }).plan?.agent.id).toBe('a')
  expect(advance(null, solo, null, 0, { view: 'team' }).research).toBe(null)
  expect(researchAgent(shot(), { view: 'research' }, null)).toBe(undefined)
})

test('a probe keeps its place on the orbit, and a new one flies out once', async () => {
  const one = advance(null, shot(agent('a', 'research', { mode: 'research', research: research({ probes: [probe('p1'), probe('p2')] }) })))
  expect(one.research?.orbit.slice(0, 3)).toEqual(['p1', 'p2', null])
  expect(one.research?.fresh).toEqual([])
  const two = advance(one, shot(agent('a', 'research', { mode: 'research', research: research({ probes: [probe('p1', 'done', { endedAt: 5 }), probe('p2'), probe('p3')] }) })))
  // p1 finished where it stood; p3 took the first free place and flies out from the agent.
  expect(two.research?.orbit.slice(0, 3)).toEqual(['p1', 'p2', 'p3'])
  expect(two.research?.fresh).toEqual(['p3'])
  const fit = fitResearch(140, 40)
  const [from, to] = [fit.layout.center, fit.layout.probe(2)]
  expect(draw(two)).toContain(`type="translate" from="${from[0]} ${from[1]}" to="${to[0]} ${to[1]}"`)
  // The next stage draws it where it stands, without the journey.
  const three = advance(two, shot(agent('a', 'research', { mode: 'research', research: research({ probes: [probe('p1', 'done', { endedAt: 5 }), probe('p2'), probe('p3', 'running', { inFlight: 1 })] }) })))
  expect(three.research?.fresh).toEqual([])
  expect(draw(three)).not.toContain('type="translate"')
  // Nothing new: the same stage.
  expect(advance(three, shot(agent('a', 'research', { mode: 'research', research: research({ probes: [probe('p1', 'done', { endedAt: 5 }), probe('p2'), probe('p3', 'running', { inFlight: 1 })] }) })))).toBe(three)
})

test('the orbit holds every probe at work first, and counts the ones it has no place for', async () => {
  const probes = [
    ...Array.from({ length: 6 }, (_, i) => probe(`old${i}`, 'done', { endedAt: i })),
    ...Array.from({ length: 5 }, (_, i) => probe(`run${i}`)),
  ]
  const scene = advance(null, shot(agent('a', 'research', { research: research({ probes }) }))).research
  if (scene === null || scene === undefined) throw new Error('no research')
  expect(scene.orbit.length).toBe(ORBIT_SLOTS)
  const placed = scene.orbit.filter((id): id is string => id !== null)
  expect(placed.filter(id => id.startsWith('run')).length).toBe(5)
  // The latest finished ones fill the rest.
  expect(placed.filter(id => id.startsWith('old')).sort()).toEqual(['old3', 'old4', 'old5'])
  expect(scene.more).toBe(3)
  expect(draw(advance(null, shot(agent('a', 'research', { research: research({ probes }) }))))).toContain('>+3 more<')
})

test('the counter says what runs and what was found, in English and in Polish', async () => {
  const r = research({ inFlight: 1, probes: [probe('p1', 'running', { inFlight: 4 }), probe('p2', 'running', { inFlight: 0 }), probe('p3', 'done')], sources: Array.from({ length: 27 }, (_, i) => ({ domain: `s${i}.example`, hits: 1 })) })
  const stage = advance(null, shot(agent('a', 'research', { mode: 'research', research: r })))
  const scene = stage.research
  if (scene === null || scene === undefined) throw new Error('no research')
  expect(counterText(scene, 'en')).toBe('in flight: 5 searches · 2 probes · 27 sources')
  expect(counterText(scene, 'pl')).toBe('w toku: 5 wyszukiwań · 2 sondy · 27 źródeł')
  expect(draw(stage)).toContain('>in flight: 5 searches · 2 probes · 27 sources<')
  expect(draw(stage, 140, 40, 'pl')).toContain('>w toku: 5 wyszukiwań · 2 sondy · 27 źródeł<')
  expect(describeScene(stage, 'en')).toBe('a: research, in flight: 5 searches · 2 probes · 27 sources')
  // One of each, and the forms Polish takes after a number.
  const single = advance(null, shot(agent('a', 'research', { mode: 'research', research: research({ probes: [probe('p1', 'running', { inFlight: 1 })], sources: [{ domain: 'x.example', hits: 1 }] }) })))
  expect(counterText(single.research as never, 'en')).toBe('in flight: 1 search · 1 probe · 1 source')
  expect(counterText(single.research as never, 'pl')).toBe('w toku: 1 wyszukiwanie · 1 sonda · 1 źródło')
  const forms = (n: number) => plPlural(n, 'sonda', 'sondy', 'sond')
  expect([0, 1, 2, 4, 5, 11, 12, 14, 21, 22, 24, 25, 102, 112].map(forms)).toEqual([
    'sond', 'sonda', 'sondy', 'sondy', 'sond', 'sond', 'sond', 'sond', 'sond', 'sondy', 'sondy', 'sond', 'sondy', 'sond',
  ])
  // A full shelf says there were more.
  const full = advance(null, shot(agent('a', 'research', { mode: 'research', research: research({ sources: [{ domain: 'x.example', hits: 1 }], sourcesCapped: true }) })))
  expect(counterText(full.research as never, 'en')).toBe('in flight: 0 searches · 0 probes · 1+ sources')
  expect(counterText(full.research as never, 'pl')).toBe('w toku: 0 wyszukiwań · 0 sond · 1+ źródeł')
})

test('pink is a question for the person and red an error, nothing else', async () => {
  const asking = draw(advance(null, shot(agent('a', 'question', { mode: 'research', research: research({ probes: [probe('p1', 'done')] }) }))))
  expect(asking).toContain(ASK)
  expect(asking).not.toContain(BAD)
  const failing = draw(advance(null, shot(agent('a', 'research', { mode: 'research', research: research({ probes: [probe('p1', 'failed')] }) }))))
  expect(failing).toContain(BAD)
  expect(failing).not.toContain(ASK)
  const calm = draw(advance(null, shot(agent('a', 'research', { mode: 'research', research: research({ probes: [probe('p1'), probe('p2', 'done'), probe('p3', 'stopped')] }) }))))
  expect(calm).not.toContain(ASK)
  expect(calm).not.toContain(BAD)
})

test('every call in flight throws a spark, up to a few per ball', async () => {
  const sparks = (inFlight: number, own = 0) =>
    (draw(advance(null, shot(agent('a', 'research', { mode: 'research', research: research({ inFlight: own, probes: [probe('p1', 'running', { inFlight })] }) })))).match(/<animateMotion/g) ?? []).length
  expect(sparks(0)).toBe(0)
  expect(sparks(3)).toBe(3)
  expect(sparks(40)).toBe(4)
  expect(sparks(0, 2)).toBe(2)
  // A finished probe throws none, whatever it once ran.
  const finished = advance(null, shot(agent('a', 'research', { mode: 'research', research: research({ probes: [probe('p1', 'done', { inFlight: 3 })] }) })))
  expect((draw(finished).match(/<animateMotion/g) ?? []).length).toBe(0)
})

test('the sparkline shows the last ten minutes and marks the peak', async () => {
  const now = 1_000_000_000
  const history = [{ at: now - 50_000, n: 2 }, { at: now - 40_000, n: 7 }, { at: now - 30_000, n: 3 }]
  const svg = draw(advance(null, shot(agent('a', 'research', { mode: 'research', research: research({ history, peak: 7, peakAt: now - 35_000 }) })), null, now))
  expect(svg).toContain('>peak 7<')
  expect(svg).toContain('IN FLIGHT · LAST 10 MIN')
  // The peak's bar is the bright one.
  expect(svg.match(/fill="#e7ebf2"\/>/g)?.length).toBe(2)
})

test('the research scene fits the element, however many probes and sources', async () => {
  const long = 'a-very-long-subdomain-name.of-a-site-with-a-long-name.example'
  const probes = Array.from({ length: MAX_PROBES }, (_, i) => probe(`p${i}`, i % 3 === 0 ? 'running' : 'done', {
    label: `${'Which of the many sources </svg> agree on this & that '.repeat(3)}${i}`, inFlight: i % 3 === 0 ? 50 : 0, calls: 999,
  }))
  // Every source with the longest address and pages a record keeps, its hover card included.
  const sources = Array.from({ length: MAX_SOURCES }, (_, i) => ({
    domain: `${i}.${long}`, hits: 99, isRead: true as const, url: `https://${i}.${long}/${'path/'.repeat(60)}`.slice(0, 300), pages: ['1-2', '3', '40-41', '7', '9', '12'],
  }))
  const history = Array.from({ length: 60 }, (_, i) => ({ at: i * 10_000, n: 99 }))
  const stage = advance(null, shot(agent('a-very-long-worktree-name-for-research', 'research', {
    mode: 'research', plan: plan('ddaaa'), research: research({ inFlight: 50, probes, sources, sourcesCapped: true, history, peak: 99, peakAt: 0 }),
  })), null, 600_000)
  for (const [columns, rows] of [[140, 40], [54, 46], [91, 46], [200, 34], [60, 70], [30, 12]] as const) {
    const svg = draw(stage, columns, rows)
    expect(svg.length).toBeLessThan(MAX_SOURCE)
    expect(svg.match(/<\/svg>/g)?.length).toBe(1)
    expect(svg).not.toContain('</svg> agree')
  }
})

test('the layout follows the pane, and nothing on it sits on anything else', async () => {
  for (const [columns, rows] of [[140, 40], [54, 46], [91, 46], [200, 34], [120, 60], [60, 70]] as const) {
    const fit = fitResearch(columns, rows)
    const { layout } = fit
    expect(fit.pixelWidth).toBe(columns * 8)
    expect(Math.abs(layout.width / layout.height - fit.pixelWidth / fit.pixelHeight)).toBeLessThan(0.01)
    const places = Array.from({ length: ORBIT_PLACES }, (_, i) => layout.probe(i))
    const half = (layout.nameMax * 6) / 2
    for (const [i, at] of places.entries()) {
      // A probe and its three lines of text are inside the drawing, above the sparkline.
      expect(at[0] - half).toBeGreaterThan(0)
      expect(at[0] + half).toBeLessThan(layout.width)
      expect(at[1] - LABEL_REACH).toBeGreaterThan(50)
      expect(at[1] + LABEL_REACH).toBeLessThan(layout.spark.y - 8)
      // Two probes at the same height leave room for both labels between them.
      for (const other of places.slice(i + 1)) {
        const isSameRow = Math.abs(at[1] - other[1]) < LABEL_REACH
        expect(!isSameRow || Math.abs(at[0] - other[0]) > 2 * half).toBe(true)
      }
    }
    // The shelf is inside the drawing and clear of the orbit.
    const { shelf } = layout
    expect(shelf.x + shelf.columns * (shelf.tile.width + shelf.tile.gap) - shelf.tile.gap).toBeLessThan(layout.width - 10)
    expect(shelf.y + shelf.rows * (shelf.tile.height + shelf.tile.gap)).toBeLessThan(layout.height - 30)
    expect(shelf.rows * shelf.columns).toBeGreaterThan(7)
    const isBeside = shelf.x > Math.max(...places.map(p => p[0])) + half
    const isBelow = shelf.y > layout.spark.y + layout.spark.height
    expect(isBeside || isBelow).toBe(true)
  }
  expect(fitResearch(140, 40).layout.kind).toBe('wide')
  expect(fitResearch(54, 46).layout.kind).toBe('narrow')
  // Too small a pane gets a whole scene to scroll.
  const tiny = fitResearch(30, 12)
  expect(tiny.pixelHeight).toBeGreaterThan(240)
})

test('a surface without a vector element gets the same facts as text', async () => {
  const r = research({
    inFlight: 1,
    probes: [probe('p1', 'done'), probe('p2', 'running', { inFlight: 3, calls: 12 }), probe('p3', 'failed', { label: '' })],
    sources: [{ domain: 'a.example', hits: 2, isRead: true }, { domain: 'b.example', hits: 1 }],
    peak: 6,
  })
  const scene = advance(null, shot(agent('a', 'research', { mode: 'research', research: r }))).research
  if (scene === null || scene === undefined) throw new Error('no research')
  const rows = researchRows(scene, 'en')
  expect(rows.map(r => r.text)).toEqual([
    'in flight: 4 searches · 1 probe · 2 sources',
    '▸ Question p2 · 3 in flight · 12 calls',
    '! subagent · failed · 5 calls',
    '✓ Question p1 · done · 5 calls',
    'peak 6',
    // A source read comes first, with where it stands; the ones only found follow.
    '✓ a.example',
    'sources: b.example',
  ])
  expect(rows[2]?.tone).toBe('bad')
  expect(researchRows(scene, 'pl')[1]?.text).toBe('▸ Question p2 · 3 w toku · 12 wywołań')
  expect(wrap('Which heat pumps work below minus twenty degrees', 16, 2)).toEqual(['Which heat pumps', 'work below…'])
  expect(wrap('Short one', 16, 2)).toEqual(['Short one'])
  expect(wrap('Supercalifragilisticexpialidocious words', 10, 1)).toEqual(['Supercali…'])
})

test('the demo researcher asks, sends probes out, finishes, and its sources pile up', async () => {
  const seen = new Set<string>()
  let most = 0
  let sources = 0
  let isPink = false
  let stage: Stage | null = null
  for (let tick = 0; tick < 44; tick++) {
    stage = advance(stage, demoResearchSnapshot(tick, 1_000_000_000 + tick * 3000), null, 1_000_000_000 + tick * 3000)
    const scene = stage.research
    if (scene === null || scene === undefined) throw new Error('the demo research is not on show')
    for (const p of scene.probes) seen.add(p.status)
    const running = scene.probes.filter(p => p.status === 'running').length
    // Five at a time at most, as the mode says.
    expect(running).toBeLessThan(6)
    most = Math.max(most, running)
    expect(scene.sources.length).toBeGreaterThan(sources - 1)
    sources = scene.sources.length
    if (scene.agent.state === 'question') isPink = true
    for (const [columns, rows] of [[140, 40], [54, 46]] as const) expect(draw(stage, columns, rows).length).toBeLessThan(MAX_SOURCE)
  }
  expect([...seen].sort()).toEqual(['done', 'failed', 'running'])
  expect(most).toBe(5)
  expect(sources).toBeGreaterThan(20)
  expect(isPink).toBe(true)
})

test('the sources read, where something was found, stand first and marked, each with its exact address on hover', async () => {
  const sources = [
    { domain: 'found-once.example', hits: 1, url: 'https://found-once.example/a' },
    { domain: 'found-often.example', hits: 4, url: 'https://found-often.example/b' },
    { domain: 'read.example', hits: 2, isRead: true as const, url: 'https://read.example/the/exact/page?q=1' },
    { domain: 'Manual.pdf', hits: 1, isRead: true as const, url: '/home/me/docs/Manual.pdf', isFile: true as const, pages: ['12-14', '20'] },
  ]
  expect(ranked(sources).map(s => s.domain)).toEqual(['read.example', 'Manual.pdf', 'found-often.example', 'found-once.example'])
  const stage = advance(null, shot(agent('a', 'research', { mode: 'research', research: research({ sources }) })))
  const svg = draw(stage)
  // Read ones first on the shelf, and marked: a dot for a page, a square for a document.
  const order = ['read.example', 'Manual.pdf', 'found-often.example', 'found-once.example'].map(d => svg.indexOf(`>${d}<`))
  expect(order.every((x, i) => x > 0 && (i === 0 || x > (order[i - 1] ?? 0)))).toBe(true)
  expect(svg).toContain('SOURCES · 4 · read 2')
  // The hover card gives the exact address, and a document's pages.
  expect(svg).toContain('https://read.example/the/exact/page?q=1')
  expect(svg).toContain('/home/me/docs/Manual.pdf')
  expect(svg).toContain('document · read · 1×')
  expect(svg).toContain('pages 12-14, 20')
  expect(svg).toContain('found in search results · 4×')
  expect(draw(stage, 140, 40, 'pl')).toContain('strony 12-14, 20')
  // As text, the read ones come with where they stand.
  const scene = stage.research
  if (scene === null || scene === undefined) throw new Error('no research')
  expect(researchRows(scene, 'en').map(r => r.text)).toContain('✓ /home/me/docs/Manual.pdf · pages 12-14, 20')
})
