import { progressOf } from '../core/plan'
import type { ProbeStatus, ResearchScene, SceneProbe, Stage } from '../../types'
import { WORDS } from './labels'
import type { Lang } from './labels'
import type { Point, ResearchLayout } from './layout'
import { card, esc, frame, gauges, meters, move, n1, shorten } from './scene'
import type { SceneOptions } from './scene'
import { ASK, BAD, colorOf } from './skin'
import type { Skin } from './skin'

// One agent's research as a scene, in the language of the other two: the
// agent in the middle, drawn by the skin; the probes it sent out on an orbit
// round it, each throwing a spark for every search it runs; the sources they
// found on a shelf; and a line of how many searches ran at once.

/** A finished probe is quiet, whatever the agent's own color: only what runs is lit. */
const DONE = '#9aa5b8'
const QUIET = '#5b6780'
const TEXT = '#c7cfdc'
const CHECK = 'M-5 0l4 4 7-8'
/** Sparks drawn per ball at most: the counter says how many run. */
const PROBE_SPARKS = 4
const AGENT_SPARKS = 6
/** Which way the agent's own sparks fly, in the order they are added: away from its name beneath it. */
const AGENT_ANGLES = [-90, 0, 180, -45, -135, 45]
const PROBE_RADIUS = 14

/** Text cut to a few lines of at most `max` characters; where it goes on, the last line says so. */
export function wrap(text: string, max: number, lines: number): string[] {
  const rows: string[] = []
  for (const word of text.split(' ').filter(w => w !== '')) {
    const last = rows[rows.length - 1]
    if (last !== undefined && `${last} ${word}`.length <= max) rows[rows.length - 1] = `${last} ${word}`
    else if (rows.length < lines) rows.push(word.length > max ? `${word.slice(0, max - 1)}…` : word)
    else {
      // Out of room: the text ends at a word, and says that it goes on.
      const kept = rows[lines - 1] ?? ''
      const space = kept.lastIndexOf(' ')
      rows[lines - 1] = `${kept.length < max ? kept : kept.slice(0, space > 0 ? space : max - 1)}…`
      break
    }
  }

  return rows
}

/** A domain as a tile has room for it: its beginning, which names it. */
const clip = (text: string, max: number) => (text.length <= max ? text : `${text.slice(0, max - 1)}…`)

const toneOf = (status: ProbeStatus, color: string) =>
  status === 'running' ? color : status === 'done' ? DONE : status === 'failed' ? BAD : QUIET

/** Directions for a few sparks, fanned about one angle. */
const fan = (count: number, most: number, angle: number): number[] => {
  const shown = Math.max(0, Math.min(count, most))

  return Array.from({ length: shown }, (_, i) => angle + (i - (shown - 1) / 2) * 15)
}

/** Sparks thrown outward from a ball's edge, one along each angle, one after another. */
function sparks(angles: readonly number[], from: number, to: number, color: string, pace: number): string {
  return angles
    .map((degrees, i) => {
      const a = (degrees * Math.PI) / 180
      const path = `M${n1(from * Math.cos(a))} ${n1(from * Math.sin(a))}L${n1(to * Math.cos(a))} ${n1(to * Math.sin(a))}`
      const begin = `${n1((i * pace) / angles.length)}s`

      return `<circle r="2.4" fill="${color}" opacity="0"><animateMotion dur="${pace}s" begin="${begin}" repeatCount="indefinite" path="${path}"/><animate attributeName="opacity" values="0;1;1;0" keyTimes="0;.15;.7;1" dur="${pace}s" begin="${begin}" repeatCount="indefinite"/></circle>`
    })
    .join('')
}

function inside(status: ProbeStatus, tone: string): string {
  switch (status) {
    case 'running':
      return `<g><path d="M0 0L0 -${PROBE_RADIUS}A${PROBE_RADIUS} ${PROBE_RADIUS} 0 0 1 12.1 -7Z" fill="${tone}" opacity=".45"/><animateTransform attributeName="transform" type="rotate" from="0" to="360" dur="2.4s" repeatCount="indefinite"/></g><circle r="2" fill="${tone}"/>`
    case 'done':
      return `<path d="${CHECK}" fill="none" stroke="${tone}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`
    case 'failed':
      return `<text y="4.5" class="t" font-size="13" font-weight="700" text-anchor="middle" fill="${BAD}">!</text>`
    case 'stopped':
      return `<path d="M-5 0h10" stroke="${tone}" stroke-width="2" stroke-linecap="round"/>`
  }
}

/** One probe on the orbit: its ball, its question, how it does; the text stands away from the agent. */
function probeBall(p: SceneProbe, at: Point, layout: ResearchLayout, color: string, o: SceneOptions, isFresh: boolean): string {
  const w = WORDS[o.lang].research
  const tone = toneOf(p.status, color)
  const [cx, cy] = layout.center
  const label = wrap(p.label === '' ? w.unnamed : p.label, layout.nameMax, 2)
  const lines = [...label, ...(o.labels ? [w.probeShort(p.status, p.inFlight)] : [])]
  const isUp = at[1] < cy
  const rows = lines
    .map((line, i) => {
      const y = isUp ? -22 - (lines.length - 1 - i) * 11 : 27 + i * 11
      const fill = i < label.length ? TEXT : p.status === 'failed' ? BAD : ''

      return `<text y="${y}" class="t st" text-anchor="middle"${fill === '' ? '' : ` style="fill:${fill}"`}>${esc(line)}</text>`
    })
    .join('')
  const glow = p.status === 'running' ? `<circle r="21" fill="${tone}" opacity=".18" filter="url(#blur)"/>` : ''
  // Sparks fly to the side away from the agent, clear of the text above or below.
  const out = p.status === 'running' ? sparks(fan(p.inFlight, PROBE_SPARKS, at[0] >= cx ? 0 : 180), 18, 46, tone, 1.2) : ''
  const travel = isFresh ? move(layout.center, at) : ''
  const dim = o.focus && p.status !== 'failed' ? ' opacity=".3"' : ''

  return `<g transform="translate(${at[0]},${at[1]})"${dim}>${travel}${glow}${out}<circle r="${PROBE_RADIUS}" fill="#0f1420" stroke="${tone}" stroke-width="1.8"${p.status === 'stopped' ? ' stroke-dasharray="3 4"' : ''}/>${inside(p.status, tone)}${rows}</g>`
}

/** A card for a pointer over a probe: its whole question and how it does. */
function probeTip(p: SceneProbe, at: Point, layout: ResearchLayout, o: SceneOptions, tone: string): string {
  const w = WORDS[o.lang].research
  const rows = [...wrap(p.label === '' ? w.unnamed : p.label, 40, 3), w.probeLine(p.status, p.inFlight, p.calls)]
  const width = 252
  const height = 30 + rows.length * 14
  const x = Math.max(6, Math.min(layout.width - width - 6, at[0] - width / 2))
  const above = at[1] - 30 - height
  const y = above < 6 ? at[1] + 30 : above
  const lines = rows.map((row, i) => `<text x="${n1(x + 10)}" y="${n1(y + 36 + i * 14)}" class="t st">${esc(row)}</text>`).join('')

  return `<g class="hit"><circle cx="${at[0]}" cy="${at[1]}" r="${PROBE_RADIUS + 4}" fill="#000" fill-opacity="0"/><g class="tip"><rect x="${n1(x)}" y="${n1(y)}" width="${width}" height="${height}" rx="7" fill="#161d2c" stroke="${tone}" stroke-opacity=".7"/><text x="${n1(x + 10)}" y="${n1(y + 19)}" class="t nm" fill="${tone}">${esc(w.probe[p.status])}</text>${lines}</g></g>`
}

/** The sources found so far, one tile per domain, first found first; a read one is lit. */
function shelf(scene: ResearchScene, layout: ResearchLayout, o: SceneOptions): string {
  const w = WORDS[o.lang]
  const { x, y, columns, rows, tile } = layout.shelf
  const room = columns * rows
  const shown = scene.sources.length > room ? scene.sources.slice(0, room - 1) : scene.sources
  const left = scene.sources.length - shown.length
  const fresh = new Set(scene.freshSources)
  const at = (i: number): Point => [x + (i % columns) * (tile.width + tile.gap), y + Math.floor(i / columns) * (tile.height + tile.gap)]
  const tiles = shown
    .map((s, i) => {
      const [tx, ty] = at(i)
      const isRead = s.isRead === true
      const appear = fresh.has(s.domain) ? '<animate attributeName="opacity" values="0;1" dur=".8s" fill="freeze"/>' : ''

      return `<g><title>${esc(w.research.tile(s.domain, s.hits, isRead))}</title>${appear}<rect x="${tx}" y="${ty}" width="${tile.width}" height="${tile.height}" rx="4" fill="${isRead ? '#17233a' : 'none'}" stroke="${isRead ? '#60a5fa' : '#3a4458'}" stroke-opacity="${isRead ? 0.6 : 1}"/><text x="${tx + 7}" y="${ty + 13.5}" class="t st" style="fill:${isRead ? TEXT : '#7c879b'}">${esc(clip(s.domain, layout.tileMax))}</text></g>`
    })
    .join('')
  const [mx, my] = at(shown.length)
  const more = left > 0 ? `<text x="${mx + 7}" y="${my + 13.5}" class="t st">${esc(w.more(left))}</text>` : ''
  const none = scene.sources.length === 0 ? `<text x="${x}" y="${y + 13.5}" class="t st">${esc(w.research.noSources)}</text>` : ''
  const count = `${scene.sources.length}${scene.sourcesCapped ? '+' : ''}`

  return `<text x="${layout.captions.shelf[0]}" y="${layout.captions.shelf[1]}" class="t cap">${esc(`${w.research.sources} · ${count}`)}</text>${tiles}${more}${none}`
}

/** How many searches ran at once, each bar ten seconds, the last one now; the peak is marked. */
function sparkline(scene: ResearchScene, layout: ResearchLayout, o: SceneOptions, color: string): string {
  const w = WORDS[o.lang].research
  const { x, y, width, height } = layout.spark
  const count = scene.series.length
  const top = Math.max(4, ...scene.series)
  const step = width / Math.max(1, count)
  const bars = scene.series
    .map((value, i) => {
      if (value <= 0) return ''
      const tall = Math.max(2, (value / top) * height)
      const isPeak = i === scene.peakIndex
      const fill = isPeak ? '#e7ebf2' : color

      return `<rect x="${n1(x + i * step + 0.6)}" y="${n1(y + height - tall)}" width="${n1(Math.max(1, step - 1.2))}" height="${n1(tall)}" rx="1" fill="${fill}"${isPeak || i === count - 1 ? '' : ' opacity=".55"'}/>`
    })
    .join('')
  const peakAt = scene.peakIndex < 0 ? undefined : x + (scene.peakIndex + 0.5) * step
  const mark = peakAt === undefined
    ? ''
    : `<path d="M${n1(peakAt - 4)} ${y - 4}L${n1(peakAt + 4)} ${y - 4}L${n1(peakAt)} ${y + 1}Z" fill="#e7ebf2"/>`
  const [cx, cy] = layout.captions.spark

  return `<text x="${cx}" y="${cy}" class="t cap">${esc(w.concurrency)}</text>${scene.peak > 0 ? `<text x="${x + width}" y="${cy}" class="t st" text-anchor="end" style="fill:#e7ebf2">${esc(w.peak(scene.peak))}</text>` : ''}<line x1="${x}" y1="${y + height + 0.5}" x2="${x + width}" y2="${y + height + 0.5}" stroke="#293040"/>${bars}${mark}`
}

/** Everything in flight now, of the agent and its probes. */
const inFlightOf = (scene: ResearchScene) => scene.inFlight + scene.probes.reduce((sum, p) => sum + (p.status === 'running' ? p.inFlight : 0), 0)

/** The line of what runs now: searches and probes in flight, and the sources found. */
export function counterText(scene: ResearchScene, lang: Lang): string {
  const running = scene.probes.filter(p => p.status === 'running').length

  return WORDS[lang].research.counter(inFlightOf(scene), running, scene.sources.length, scene.sourcesCapped)
}

/** One document for one agent's research: no script, every motion baked in as SMIL. */
export function renderResearch(stage: Stage, scene: ResearchScene, layout: ResearchLayout, skin: Skin, o: SceneOptions): string {
  const w = WORDS[o.lang]
  const { width, height } = layout
  const agent = scene.agent
  const color = colorOf(agent.id)
  const levels = stage.levels ?? null
  const [cx, cy] = layout.center
  const fresh = new Set(scene.fresh)
  const byId = new Map(scene.probes.map(p => [p.id, p]))
  let lines = ''
  let balls = ''
  let tips = ''

  scene.orbit.forEach((id, place) => {
    const p = id === null ? undefined : byId.get(id)
    if (p === undefined) return
    const at = layout.probe(place)
    const tone = toneOf(p.status, color)
    if (o.links) {
      lines += p.status === 'running'
        ? `<line x1="${cx}" y1="${cy}" x2="${at[0]}" y2="${at[1]}" stroke="${color}" stroke-opacity=".35" stroke-dasharray="2 6"/>`
        : `<line x1="${cx}" y1="${cy}" x2="${at[0]}" y2="${at[1]}" stroke="#3a4458" stroke-opacity=".6"/>`
    }
    balls += probeBall(p, at, layout, color, o, fresh.has(p.id))
    tips += probeTip(p, at, layout, o, tone)
  })

  // The agent in the middle, as the plan's scene draws it.
  const isDim = agent.isAsleep || (o.focus && !agent.needsAttention)
  const alarm = agent.state === 'failed' ? BAD : ASK
  const label = o.labels
    ? `<text y="76" class="t st" text-anchor="middle"${agent.needsAttention ? ` style="fill:${alarm}"` : ''}>${esc(agent.isAsleep ? w.asleep : w.state[agent.state])}</text>`
    : ''
  const mode = agent.mode === undefined ? '' : `<text y="${o.labels ? 90 : 78}" class="t st" text-anchor="middle">${esc(`${w.mode}: ${shorten(agent.mode, 18)}`)}</text>`
  const more = scene.more > 0 ? `<text y="${o.labels ? 104 : 92}" class="t st" text-anchor="middle">${esc(w.more(scene.more))}</text>` : ''
  const reach = Math.round(Math.min(layout.orbit.rx, layout.orbit.ry) * 0.55)
  const own = agent.isAsleep ? '' : sparks(AGENT_ANGLES.slice(0, Math.min(scene.inFlight, AGENT_SPARKS)), 40, reach, color, 1.4)
  const lead = `<g transform="translate(${cx},${cy})"${isDim ? ' opacity=".4"' : ''}>${own}${mode}${more}<g><circle r="38" fill="none" stroke="${QUIET}" stroke-width="1.5" stroke-dasharray="3 7"/><animateTransform attributeName="transform" type="rotate" from="0" to="360" dur="30s" repeatCount="indefinite"/></g>${gauges(levels?.agents[agent.id], color, o.labels ? 97 : 84, 30)}<g transform="scale(1.12)">${skin.glyph(agent, { color })}</g><text y="62" class="t nm" text-anchor="middle" fill="${color}">${esc(shorten(agent.id, 22))}</text>${label}</g>`
  tips += `<g class="hit"><circle cx="${cx}" cy="${cy}" r="30" fill="#000" fill-opacity="0"/>${card(agent, layout.center, layout, o, levels?.cores ?? 1)}</g>`

  const plan = agent.plan ?? []
  const current = plan.findIndex(s => s.status === 'active')
  const { done, total } = progressOf(plan)
  const hudTop = current >= 0
    ? `${w.step(current + 1, total)} · ${shorten(plan[current]?.text ?? '', 40)}`
    : total > 0 ? w.stepsDone(done, total) : (agent.isAsleep ? w.asleep : w.state[agent.state])
  const count = (status: ProbeStatus) => scene.probes.filter(p => p.status === status).length
  const hudBottom = w.research.summary(count('running'), count('done'), count('stopped'), count('failed'), scene.calls)
  const { at, anchor } = layout.counter

  return frame(width, height, skin, o, `<ellipse cx="${cx}" cy="${cy}" rx="${layout.orbit.rx}" ry="${layout.orbit.ry}" fill="none" stroke="#293040" stroke-dasharray="2 8"/>
<g>${lines}</g>
${lead}
<g>${balls}</g>
${shelf(scene, layout, o)}
${sparkline(scene, layout, o, color)}
<text x="${layout.hudTop[0]}" y="${layout.hudTop[1]}" class="t hud">${esc(hudTop)}</text>
<text x="${at[0]}" y="${at[1]}" class="t hud"${anchor === 'end' ? ' text-anchor="end"' : ''}>${esc(counterText(scene, o.lang))}</text>
<text x="${layout.hudBottom[0]}" y="${layout.hudBottom[1]}" class="t st">${esc(hudBottom)}</text>
${meters(levels, layout.meters)}
<g>${tips}</g>`)
}

/** One line of the research as text, for a surface that draws no vector. */
export type ResearchRow = { key: string; text: string; tone?: 'ask' | 'bad'; isDim?: boolean }

const MARKS: Record<ProbeStatus, string> = { running: '▸', done: '✓', stopped: '·', failed: '!' }

/** The same facts as the drawing, as lines of text: what runs, each probe, the peak, the sources. */
export function researchRows(scene: ResearchScene, lang: Lang): ResearchRow[] {
  const w = WORDS[lang].research
  const order: ProbeStatus[] = ['running', 'failed', 'done', 'stopped']
  const probes = order.flatMap(status => scene.probes.filter(p => p.status === status))
  const domains = scene.sources.slice(0, 12).map(s => s.domain)
  const left = scene.sources.length - domains.length

  return [
    { key: 'research-counter', text: counterText(scene, lang) },
    ...probes.map(p => ({
      key: `probe-${p.id}`,
      text: `${MARKS[p.status]} ${shorten(p.label === '' ? w.unnamed : p.label, 60)} · ${w.probeLine(p.status, p.inFlight, p.calls)}`,
      ...(p.status === 'failed' ? { tone: 'bad' as const } : {}),
      ...(p.status === 'running' ? {} : { isDim: true }),
    })),
    ...(scene.peak > 0 ? [{ key: 'research-peak', text: w.peak(scene.peak) }] : []),
    ...(domains.length === 0 ? [] : [{ key: 'research-sources', text: `${w.sources.toLowerCase()}: ${domains.join(', ')}${left > 0 ? ` ${WORDS[lang].more(left)}` : ''}` }]),
  ]
}
