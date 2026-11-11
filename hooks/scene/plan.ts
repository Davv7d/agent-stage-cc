import { progressOf } from '../core/plan'
import type { PlanScene, SceneStep, Stage, StepPlace } from '../../types'
import { WORDS } from './labels'
import type { PlanLayout, Point } from './layout'
import { card, esc, frame, gauges, meters, move, n1, ring, shorten } from './scene'
import type { SceneOptions } from './scene'
import { ASK, BAD, colorOf } from './skin'
import type { Skin } from './skin'

// One agent's plan as a scene, in the team scene's own language: the same
// balls, zones and glides. There the agents move between zones; here the
// steps do, from waiting, through in progress, to done.

const DONE = '#86efac'
const QUIET = '#5b6780'
const CHECK = 'M-5 0l4 4 7-8'

function pointOf(layout: PlanLayout, place: StepPlace | undefined): Point | undefined {
  if (place === undefined) return undefined
  switch (place.zone) {
    case 'todo':
      return layout.todo(place.index)
    case 'active':
      return layout.active(place.index)
    case 'gate':
      return layout.gate
    case 'done':
      return layout.done(place.index)
  }
}

/** How fast work shows on the line to the step in progress; none while the agent rests. */
const PACE: Partial<Record<string, number>> = { research: 1.9, coding: 1.3, testing: 0.8 }

/** Sparks running from the agent to the step it works on, for as long as it works. */
function flow(from: Point, to: Point, color: string, pace: number | undefined): string {
  const line = `<line x1="${from[0]}" y1="${from[1]}" x2="${to[0]}" y2="${to[1]}" stroke="${color}" stroke-opacity=".35" stroke-dasharray="2 6"/>`
  if (pace === undefined) return line
  const path = `M${n1(from[0])} ${n1(from[1])}L${n1(to[0])} ${n1(to[1])}`
  const sparks = [0, 0.37, 0.7]
    .map((part, i) => `<circle r="${i === 2 ? 2 : 2.6}" fill="${color}"><animateMotion dur="${pace}s" begin="${n1(part * pace)}s" repeatCount="indefinite" path="${path}"/></circle>`)
    .join('')

  return line + sparks
}

function stepBall(step: SceneStep, place: StepPlace, scene: PlanScene, color: string, nameMax: number): string {
  const state = scene.agent.state
  const isActive = place.zone === 'active'
  const radius = isActive ? 19 : 13
  const tone = place.zone === 'done' ? DONE
    : place.zone === 'gate' ? ASK
    : !isActive ? QUIET
    : state === 'failed' ? BAD
    : scene.isWaiting ? ASK
    : color
  const isBusy = isActive && PACE[state] !== undefined
  const wave = isBusy || place.zone === 'gate' || (isActive && tone !== color)
    ? `<circle r="${radius}" fill="none" stroke="${tone}" stroke-width="1.6"><animate attributeName="r" values="${radius};${radius + 16}" dur="1.7s" repeatCount="indefinite"/><animate attributeName="opacity" values=".8;0" dur="1.7s" repeatCount="indefinite"/></circle>`
    : ''
  const glow = isActive ? `<circle r="26" fill="${tone}" opacity=".2" filter="url(#blur)"/>` : ''
  const inside = place.zone === 'done' || place.zone === 'gate'
    ? `<path d="${CHECK}" fill="none" stroke="${tone}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`
    : `<text y="${isActive ? 4.5 : 3.5}" class="t" font-size="${isActive ? 12 : 9.5}" font-weight="600" text-anchor="middle" fill="${isActive ? tone : '#9aa5b8'}">${step.ordinal}</text>`
  const label = `<text y="${radius + 15}" class="t ${isActive ? 'nm' : 'st'}" text-anchor="middle"${isActive ? ' fill="#e7ebf2"' : ''}>${esc(shorten(step.text, nameMax))}</text>`

  return `${glow}${wave}<circle r="${radius}" fill="#0f1420" stroke="${tone}" stroke-width="${isActive ? 2 : 1.5}"${place.zone === 'todo' ? ' stroke-opacity=".8"' : ''}/>${inside}${label}`
}

/** A step's whole text, for a pointer over its ball. */
function stepTip(step: SceneStep, total: number, at: Point, layout: PlanLayout, o: SceneOptions, tone: string): string {
  const rows: string[] = []
  for (const word of step.text.split(' ')) {
    const last = rows[rows.length - 1]
    if (last !== undefined && `${last} ${word}`.length <= 40) rows[rows.length - 1] = `${last} ${word}`
    else if (rows.length < 3) rows.push(shorten(word, 40))
    else {
      // Out of room: the text ends here, and says that it goes on.
      rows[2] = `${(rows[2] ?? '').slice(0, 39)}…`
      break
    }
  }
  const width = 252
  const height = 30 + rows.length * 14
  const x = Math.max(6, Math.min(layout.width - width - 6, at[0] - width / 2))
  const above = at[1] - 30 - height
  const y = above < 6 ? at[1] + 44 : above
  const lines = rows.map((row, i) => `<text x="${n1(x + 10)}" y="${n1(y + 36 + i * 14)}" class="t st">${esc(row)}</text>`).join('')

  return `<g class="hit"><circle cx="${at[0]}" cy="${at[1]}" r="20" fill="#000" fill-opacity="0"/><g class="tip"><rect x="${n1(x)}" y="${n1(y)}" width="${width}" height="${height}" rx="7" fill="#161d2c" stroke="${tone}" stroke-opacity=".7"/><text x="${n1(x + 10)}" y="${n1(y + 19)}" class="t nm" fill="${tone}">${esc(WORDS[o.lang].step(step.ordinal, total))}</text>${lines}</g></g>`
}

/** One document for one agent's plan: no script, every motion baked in as SMIL. */
export function renderPlan(stage: Stage, scene: PlanScene, layout: PlanLayout, skin: Skin, o: SceneOptions): string {
  const w = WORDS[o.lang]
  const { width, height } = layout
  const agent = scene.agent
  const color = colorOf(agent.id)
  const levels = stage.levels ?? null
  const total = scene.steps.length
  let links = ''
  let balls = ''
  let tips = ''
  let atGate = false

  for (const step of scene.steps) {
    const place = scene.places[step.key]
    const at = pointOf(layout, place)
    if (at === undefined || place === undefined) continue
    const was = pointOf(layout, scene.prevPlaces[step.key])
    const travel = was !== undefined && (was[0] !== at[0] || was[1] !== at[1]) ? move(was, at) : ''
    balls += `<g transform="translate(${at[0]},${at[1]})">${travel}${stepBall(step, place, scene, color, layout.nameMax)}</g>`
    tips += stepTip(step, total, at, layout, o, place.zone === 'done' ? DONE : place.zone === 'gate' ? ASK : color)
    if (place.zone === 'active') {
      const tone = agent.state === 'failed' ? BAD : scene.isWaiting ? ASK : color
      links += flow(layout.agent, at, tone, o.links ? PACE[agent.state] : undefined)
    }
    if (place.zone === 'gate') atGate = true
  }

  const [ax, ay] = layout.agent
  const isDim = agent.isAsleep
  const label = o.labels
    ? `<text y="76" class="t st" text-anchor="middle"${agent.needsAttention ? ` style="fill:${agent.state === 'failed' ? BAD : ASK}"` : ''}>${esc(agent.isAsleep ? w.asleep : w.state[agent.state])}</text>`
    : ''
  // The working mode the session is in, said under the agent.
  const mode = agent.mode === undefined
    ? ''
    : `<text y="${o.labels ? 98 : 85}" class="t st" text-anchor="middle">${esc(`${w.mode}: ${shorten(agent.mode, 18)}`)}</text>`
  const lead = `<g transform="translate(${ax},${ay})"${isDim ? ' opacity=".4"' : ''}>${mode}<g><circle r="38" fill="none" stroke="${QUIET}" stroke-width="1.5" stroke-dasharray="3 7"/><animateTransform attributeName="transform" type="rotate" from="0" to="360" dur="30s" repeatCount="indefinite"/></g>${gauges(levels?.agents[agent.id], color, o.labels ? 83 : 70, 30)}<g transform="scale(1.12)">${skin.glyph(agent, { color })}</g><text y="62" class="t nm" text-anchor="middle" fill="${color}">${esc(shorten(agent.id, 22))}</text>${label}</g>`
  tips += `<g class="hit"><circle cx="${ax}" cy="${ay}" r="30" fill="#000" fill-opacity="0"/>${card(agent, layout.agent, layout, o, levels?.cores ?? 1)}</g>`

  // The gate shows only while a step stands at it: a run that never stops has none.
  const [g0, g1] = layout.gateLine
  const [gx, gy] = layout.gate
  // The line stops short of the step that stands on it, and of its name.
  const upright = g0[0] === g1[0]
  const before: Point = upright ? [gx, gy - 28] : [gx - 28, gy]
  const after: Point = upright ? [gx, gy + 42] : [gx + 28, gy]
  const dashes = (from: Point, to: Point) =>
    `<line x1="${from[0]}" y1="${from[1]}" x2="${to[0]}" y2="${to[1]}" stroke="${ASK}" stroke-opacity=".55" stroke-dasharray="3 7"/>`
  const gate = atGate
    ? `${dashes(g0, before)}${dashes(after, g1)}<text x="${layout.captions.gate[0]}" y="${layout.captions.gate[1]}" class="t st" text-anchor="middle" style="fill:${ASK}">${esc(w.gate)}</text>`
    : ''

  const { done, active, left } = progressOf(agent.plan ?? [])
  const current = scene.steps.find(s => s.status === 'active')
  const hudTop = current === undefined
    ? w.stepsDone(done, total)
    : `${w.step(current.ordinal, total)} · ${shorten(current.text, 46)}`
  const shared = stage.resource
  const hudResource = shared === null
    ? ''
    : `${shared.name}: ${shared.holder ?? (shared.phase === 'restoring' ? w.restoring : w.free)} · ${w.queue} ${shared.queue.length}`
  const caption = (at: Point, text: string) => `<text x="${at[0]}" y="${at[1]}" class="t cap" text-anchor="middle">${esc(text)}</text>`
  const more = (at: Point, count: number) =>
    count > 0 ? `<text x="${at[0]}" y="${at[1]}" class="t st" text-anchor="middle">${esc(w.more(count))}</text>` : ''

  return frame(width, height, skin, o, `${caption(layout.captions.agent, w.planAgent)}${caption(layout.captions.todo, w.planTodo)}${caption(layout.captions.active, w.planActive)}${caption(layout.captions.done, w.planDone)}
${gate}<g>${links}</g>
${shared === null || layout.ring === undefined ? '' : ring({ ...shared, queue: [] }, layout, o, levels)}
${lead}
<g>${balls}</g>
${more(layout.more.todo, scene.more.todo)}${more(layout.more.done, scene.more.done)}
<text x="${layout.hudTop[0]}" y="${layout.hudTop[1]}" class="t hud">${esc(hudTop)}</text>
${hudResource === '' ? '' : `<text x="${width - layout.hudTop[0]}" y="${layout.hudTop[1] + (layout.kind === 'narrow' ? 16 : 0)}" class="t hud" text-anchor="end">${esc(hudResource)}</text>`}
<text x="${layout.hudBottom[0]}" y="${layout.hudBottom[1]}" class="t st">${esc(w.planCounts(done, active, left))}</text>
${meters(levels, layout.meters)}
<g>${tips}</g>`)
}
