import type {
  AgentView,
  Place,
  PlanScene,
  ResearchScene,
  SceneStep,
  StepPlace,
  ViewMode,
  SceneAgent,
  SceneResource,
  Slots,
  Snapshot,
  Spark,
  Stage,
  UsageLevels,
  UsageReport,
} from '../../types'
import { glance } from '../core/plan'
import { emptyResearch, seriesOf } from '../core/research'
import { levelsOf } from '../core/usage'

export type { Place, SceneAgent, SceneResource, Slots, Spark, Stage }

export const WORK_SLOTS = 15
export const PR_SLOTS = 5
export const QUEUE_SLOTS = 6
/** Places per zone of a plan; the steps beyond them are counted, not drawn. */
export const PLAN_TODO_SLOTS = 4
export const PLAN_ACTIVE_SLOTS = 2
export const PLAN_DONE_SLOTS = 4
/** Places on a research's orbit; the probes beyond them are counted, not drawn. */
export const ORBIT_SLOTS = 8

const empty = (): Slots => ({
  work: Array<string | null>(WORK_SLOTS).fill(null),
  pr: Array<string | null>(PR_SLOTS).fill(null),
})

const toScene = (a: AgentView, isQueued: boolean, usage: UsageReport | null = null): SceneAgent => ({
  id: a.id,
  // Waiting in line is what a queued agent shows, unless it needs the person.
  state: isQueued && !a.needsAttention && a.state !== 'done' ? 'queue' : a.state,
  isAsleep: a.isAsleep && !isQueued,
  needsAttention: a.needsAttention,
  branch: a.branch,
  lastAction: a.lastAction,
  since: a.since,
  promptAt: a.promptAt,
  ...(a.pr?.url === undefined ? {} : { prUrl: a.pr.url }),
  ...(usage?.agents[a.id] === undefined ? {} : { usage: usage.agents[a.id] }),
  ...(a.plan === undefined || a.plan.length === 0 ? {} : { plan: a.plan }),
  ...(a.mode === undefined ? {} : { mode: a.mode }),
})

export type StageOptions = {
  view?: ViewMode
  /** The agent of the session that shows the pane. */
  self?: string
}

const hasPlan = (a: AgentView) => (a.plan?.length ?? 0) > 0

/**
 * Whose plan the pane shows, if any. Left to itself the stage shows a plan
 * when one agent alone is in play and keeps one: with more agents at work
 * the team is the scene.
 */
export function planAgent(shot: Snapshot, options: StageOptions, prev: Stage | null): AgentView | undefined {
  const view = options.view ?? 'auto'
  if (view === 'team') return undefined
  const was = shot.agents.find(a => a.id === prev?.plan?.agent.id && hasPlan(a))
  if (view === 'plan') {
    return shot.agents.find(a => a.id === options.self && hasPlan(a)) ?? was ?? shot.agents.find(a => !a.isAsleep && hasPlan(a)) ?? shot.agents.find(hasPlan)
  }
  const inPlay = shot.agents.filter(a => !a.isAsleep && a.state !== 'done')
  if (inPlay.length === 1) return inPlay[0] !== undefined && hasPlan(inPlay[0]) ? inPlay[0] : undefined

  // Everyone rests: the plan that was on show stays on show.
  return inPlay.length === 0 ? was : undefined
}

/** An agent researching now: in the research mode, or with a probe out. */
const isResearching = (a: AgentView) => a.mode === 'research' || (a.research?.probes.some(p => p.status === 'running') ?? false)

/**
 * Whose research the pane shows, if any. Asked for, it is the session's own;
 * left to itself, the stage shows it when one agent alone is in play and that
 * agent researches: it is in the research mode, or has a probe out.
 */
export function researchAgent(shot: Snapshot, options: StageOptions, prev: Stage | null): AgentView | undefined {
  const view = options.view ?? 'auto'
  if (view === 'team' || view === 'plan') return undefined
  const was = shot.agents.find(a => a.id === prev?.research?.agent.id)
  if (view === 'research') {
    return shot.agents.find(a => a.id === options.self) ?? was ??
      shot.agents.find(a => !a.isAsleep && a.research !== undefined) ?? shot.agents.find(a => a.research !== undefined) ??
      shot.agents.find(a => !a.isAsleep && a.state !== 'done')
  }
  const inPlay = shot.agents.filter(a => !a.isAsleep && a.state !== 'done')
  if (inPlay.length === 1) return inPlay[0] !== undefined && isResearching(inPlay[0]) ? inPlay[0] : undefined

  // Everyone rests: the research that was on show stays on show.
  return inPlay.length === 0 ? was : undefined
}

function researchScene(prev: Stage | null, a: AgentView, usage: UsageReport | null, now: number): ResearchScene {
  const r = a.research ?? emptyResearch(0)
  const before = prev?.research?.agent.id === a.id ? prev.research : null
  // The orbit holds every probe at work, then the latest finished ones.
  const ended = r.probes.filter(p => p.status !== 'running').sort((x, y) => (y.endedAt ?? 0) - (x.endedAt ?? 0))
  const wanted = [...r.probes.filter(p => p.status === 'running'), ...ended].slice(0, ORBIT_SLOTS).map(p => p.id)
  const orbit = seat(before?.orbit ?? Array<string | null>(ORBIT_SLOTS).fill(null), wanted)
  const known = new Set(before?.probes.map(p => p.id) ?? [])
  const shelved = new Set(before?.sources.map(s => s.domain) ?? [])
  const { series, peakIndex } = seriesOf(r, now)

  return {
    agent: toScene(a, false, usage),
    orbit,
    probes: r.probes.map(p => ({ id: p.id, label: p.label, status: p.status, inFlight: p.inFlight, calls: p.calls })),
    fresh: before === null ? [] : wanted.filter(id => !known.has(id)),
    inFlight: r.inFlight,
    calls: r.calls,
    sources: r.sources,
    sourcesCapped: r.sourcesCapped === true,
    freshSources: before === null ? [] : r.sources.filter(s => !shelved.has(s.domain)).map(s => s.domain),
    series,
    peak: r.peak,
    peakIndex,
    more: Math.max(0, r.probes.length - orbit.filter(id => id !== null).length),
  }
}

function planScene(prev: Stage | null, a: AgentView, usage: UsageReport | null): PlanScene {
  const seen = new Map<string, number>()
  const steps = (a.plan ?? []).map((s, i) => {
    const name = s.id === undefined ? s.text : `#${s.id}`
    const count = seen.get(name) ?? 0
    seen.set(name, count + 1)

    return { key: count === 0 ? name : `${name}~${count}`, ordinal: i + 1, text: s.text, status: s.status, doneAt: s.doneAt ?? 0 }
  })
  const isWaiting = (a.state === 'idle' || a.state === 'question') && steps.some(s => s.status !== 'done')
  const todo = steps.filter(s => s.status === 'pending')
  const active = steps.filter(s => s.status === 'active')
  const done = steps.filter(s => s.status === 'done')
  // The step just finished stands at the gate while the agent waits to go on.
  const held = isWaiting && active.length === 0
    ? done.reduce<(typeof done)[number] | undefined>((last, s) => (last === undefined || s.doneAt >= last.doneAt ? s : last), undefined)
    : undefined
  const past = done.filter(s => s !== held)
  const places: Record<string, StepPlace> = {}
  todo.slice(0, PLAN_TODO_SLOTS).forEach((s, index) => (places[s.key] = { zone: 'todo', index }))
  active.slice(0, PLAN_ACTIVE_SLOTS).forEach((s, index) => (places[s.key] = { zone: 'active', index }))
  past.slice(-PLAN_DONE_SLOTS).forEach((s, index) => (places[s.key] = { zone: 'done', index }))
  if (held !== undefined) places[held.key] = { zone: 'gate', index: 0 }

  return {
    agent: toScene(a, false, usage),
    steps: steps.map(({ doneAt: _at, ...step }): SceneStep => step),
    places,
    prevPlaces: prev?.plan?.agent.id === a.id ? prev.plan.places : {},
    isWaiting,
    more: { todo: Math.max(0, todo.length - PLAN_TODO_SLOTS), done: Math.max(0, past.length - PLAN_DONE_SLOTS) },
  }
}

function seat(previous: readonly (string | null)[], wanted: readonly string[]): (string | null)[] {
  const seats = previous.map(id => (id !== null && wanted.includes(id) ? id : null))
  for (const id of wanted) {
    if (seats.includes(id)) continue
    const free = seats.indexOf(null)
    if (free >= 0) seats[free] = id
  }

  return seats
}

/** Usage alone redraws the scene at most this often; a state change does at once. */
export const USAGE_REDRAW_MS = 30_000

/**
 * The next stage. Exact figures ride along for the hover cards without
 * making a stage new; their coarse steps do, but no more often than
 * `USAGE_REDRAW_MS`, so a number wobbling across a step cannot flicker.
 */
export function advance(
  prev: Stage | null,
  shot: Snapshot,
  usage: UsageReport | null = null,
  now = 0,
  options: StageOptions = {},
): Stage {
  const lead = shot.agents.find(a => a.role === 'coordinator')
  const coordinator = lead === undefined ? null : toScene(lead, false)
  // An agent's research, when it is on show, takes the place of its plan.
  const researched = researchAgent(shot, options, prev)
  const planned = researched === undefined ? planAgent(shot, options, prev) : undefined
  const found = researched === undefined ? undefined : (researched.research ?? emptyResearch(0))
  // The scene draws one shared resource: the first by name.
  const shared = shot.resources[0]
  const resource: SceneResource | null = shared === undefined
    ? null
    : {
        name: shared.name, holder: shared.holder, queue: shared.queue, members: shared.members,
        swapped: shared.swapped, phase: shared.phase, isUrgent: shared.isUrgent, isStale: shared.isStale,
      }
  const queue = resource?.queue ?? []
  const agents = shot.agents.filter(a => a !== lead).map(a => toScene(a, queue.includes(a.id), usage))
  const fresh: UsageLevels | null = usage === null ? null : levelsOf(usage)
  const facts = JSON.stringify([
    coordinator === null ? null : [coordinator.id, coordinator.state, coordinator.mode ?? 0],
    agents.map(a => [a.id, a.state, a.isAsleep, a.promptAt, a.prUrl ?? '', a.plan === undefined ? 0 : glance(a.plan), a.mode ?? 0]),
    resource,
    planned === undefined ? 0 : [planned.id, planned.state, planned.isAsleep, planned.plan?.map(s => s.status[0] + s.text), planned.mode ?? 0],
    researched === undefined || found === undefined
      ? 0
      : [
          researched.id, researched.state, researched.isAsleep, researched.mode ?? 0, researched.plan?.map(s => s.status[0] + s.text) ?? 0,
          found.probes.map(p => [p.id, p.label, p.status, p.inFlight, p.calls]), found.inFlight, found.calls,
          found.sources.map(s => [s.domain, s.hits, s.isRead === true ? 1 : 0]), found.sourcesCapped === true ? 1 : 0,
          found.peak, seriesOf(found, now),
        ],
  ])
  const isSameScene = prev !== null && prev.key.startsWith(facts)
  const mayFollow = prev === null || prev.levels === null || now - prev.levelsAt >= USAGE_REDRAW_MS
  // While nothing else changed and the last usage redraw is recent, the
  // steps on show stay; any other change takes the fresh ones along.
  const levels = isSameScene && !mayFollow ? (prev?.levels ?? fresh) : fresh
  const key = facts + JSON.stringify(levels)
  if (prev !== null && prev.key === key) return prev
  const levelsAt = JSON.stringify(levels) === JSON.stringify(prev?.levels ?? null) ? (prev?.levelsAt ?? now) : now

  const before = prev?.slots ?? empty()
  const special = new Set([...queue, ...(resource?.holder == null ? [] : [resource.holder])])
  const zoneOf = (a: SceneAgent) => (a.state === 'pr' || a.state === 'done' ? 'pr' : 'work')
  const inZone = (zone: keyof Slots) =>
    agents.filter(a => !special.has(a.id) && zoneOf(a) === zone).map(a => a.id)
  const slots: Slots = { work: seat(before.work, inZone('work')), pr: seat(before.pr, inZone('pr')) }

  const places: Record<string, Place> = {}
  for (const a of agents) {
    const inLine = queue.indexOf(a.id)
    if (resource?.holder === a.id) places[a.id] = { zone: 'holder', index: 0 }
    else if (inLine >= 0) {
      if (inLine < QUEUE_SLOTS) places[a.id] = { zone: 'queue', index: inLine }
    } else {
      const work = slots.work.indexOf(a.id)
      const pr = slots.pr.indexOf(a.id)
      if (work >= 0) places[a.id] = { zone: 'work', index: work }
      else if (pr >= 0) places[a.id] = { zone: 'pr', index: pr }
    }
  }

  const sparks: Spark[] = []
  if (prev !== null) {
    const was = new Map(prev.agents.map(a => [a.id, a]))
    for (const a of agents) {
      const old = was.get(a.id)
      if (a.state === 'question' && old?.state !== 'question') sparks.push({ agent: a.id, kind: 'ask' })
      else if (old === undefined || a.promptAt > old.promptAt) sparks.push({ agent: a.id, kind: 'order' })
    }
  }

  const plan = planned === undefined ? null : planScene(prev, planned, usage)
  const research = researched === undefined ? null : researchScene(prev, researched, usage, now)

  return { key, coordinator, agents, resource, slots, places, prevPlaces: prev?.places ?? {}, sparks, plan, research, levels, levelsAt }
}
