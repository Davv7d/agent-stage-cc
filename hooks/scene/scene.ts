import type { AgentState } from '../../types'
import { usageText } from '../core/usage'
import { WORDS } from './labels'
import type { Lang } from './labels'
import { RING_INNER, RING_OUTER } from './layout'
import type { Layout, Point } from './layout'
import { ASK, BAD, colorOf, WARN } from './skin'
import type { Skin } from './skin'
import type { UsageLevels } from '../../types'
import type { Place, SceneAgent, SceneResource, Stage } from './stage'

export type SceneOptions = {
  lang: Lang
  /** Dim every agent that is doing fine on its own. */
  focus: boolean
  /** Show the state under each name. */
  labels: boolean
  /** Draw the lines between the coordinator and working agents. */
  links: boolean
  /** Minutes east of UTC, for the clock time in a hover card. */
  utcOffsetMinutes: number
  /** How large the drawing is shown, in CSS pixels. */
  pixelWidth: number
  pixelHeight: number
}

/** The `Svg` element takes a document of at most this many characters. */
export const MAX_SOURCE = 131072

export const esc = (text: string) =>
  text.replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')

const n1 = (value: number) => (Math.round(value * 10) / 10).toString()

export const shorten = (name: string, max: number) =>
  name.length <= max ? name : `${name.slice(0, Math.ceil((max - 1) / 2))}…${name.slice(-Math.floor((max - 1) / 2))}`

function clock(ms: number, offsetMinutes: number): string {
  const day = (((Math.floor(ms / 60000) + offsetMinutes) % 1440) + 1440) % 1440

  return `${String(Math.floor(day / 60)).padStart(2, '0')}:${String(day % 60).padStart(2, '0')}`
}

function pointOf(layout: Layout, place: Place | undefined): Point | undefined {
  if (place === undefined) return undefined
  switch (place.zone) {
    case 'work':
      return layout.work(place.index)
    case 'pr':
      return layout.pr(place.index)
    case 'queue':
      return layout.ring?.queue(place.index)
    case 'holder':
      return layout.ring?.center
  }
}

/** How a container's load reads on the ring's rim, quiet to heavy. */
const LOAD_TONES = ['', '#5b6780', '#c7cfdc', WARN]

/** Around an agent's ball: how far the CPU arc runs at each step. */
const CPU_ARC = [0, 0.25, 0.55, 0.9]
const ARC_RADIUS = 21

/** An agent's cost at a glance: an arc for CPU, a short bar for memory. */
function gauges(level: { cpu: number; ram: number } | undefined, color: string, barAt: number): string {
  if (level === undefined) return ''
  const share = CPU_ARC[level.cpu] ?? 0
  const end = -90 + share * 360
  const tone = level.cpu >= 3 ? WARN : color
  const arc = share === 0
    ? ''
    : `<circle r="${ARC_RADIUS}" fill="none" stroke="#293040" stroke-width="2"/><path d="M${polar([0, 0], ARC_RADIUS, -90)}A${ARC_RADIUS} ${ARC_RADIUS} 0 ${share > 0.5 ? 1 : 0} 1 ${polar([0, 0], ARC_RADIUS, end)}" fill="none" stroke="${tone}" stroke-width="2" stroke-linecap="round"/>`
  const bar = level.ram === 0
    ? ''
    : `<rect x="-20" y="${barAt}" width="40" height="3" rx="1.5" fill="#293040"/><rect x="-20" y="${barAt}" width="${level.ram * 10}" height="3" rx="1.5" fill="${level.ram >= 4 ? WARN : color}"/>`

  return arc + bar
}

/** The stage's own share of a meter, drawn over the machine's. */
const OWN = '#e7ebf2'

/**
 * How loaded the whole machine is, bottom of the scene, and how much of
 * that is the stage's own: the bright end of each bar, the first figure
 * beside it.
 */
function meters(levels: UsageLevels | null, at: Point): string {
  if (levels === null) return ''
  const [x, y] = at
  const ofMachine = (gb: number) => (levels.machineGb <= 0 ? 0 : Math.min(1, gb / levels.machineGb))
  const fill = (left: number, share: number, color: string) =>
    share <= 0 ? '' : `<rect x="${left + 26}" y="${y - 7}" width="${n1(Math.max(3, share * 60))}" height="6" rx="3" fill="${color}"/>`
  const meter = (left: number, label: string, share: number, own: number, value: string) =>
    `<text x="${left}" y="${y}" class="t st">${label}</text><rect x="${left + 26}" y="${y - 7}" width="60" height="6" rx="3" fill="#293040"/>${fill(left, share, share >= 0.8 ? WARN : '#60a5fa')}${fill(left, Math.min(own, share), OWN)}<text x="${left + 92}" y="${y}" class="t st"><tspan fill="${OWN}">${esc(value.split(' / ')[0] ?? '')}</tspan>${esc(value.slice(value.indexOf(' / ')))}</text>`

  return (
    meter(x, 'CPU', levels.cpuPercent / 100, (levels.ownCpuPercent ?? 0) / 100, `${levels.ownCpuPercent ?? 0} / ${levels.cpuPercent}%`) +
    meter(x + 150, 'RAM', ofMachine(levels.ramGb), ofMachine(levels.ownRamGb ?? 0), `${levels.ownRamGb ?? 0} / ${levels.ramGb} / ${levels.machineGb} GB`)
  )
}

const polar = (center: Point, radius: number, degrees: number) =>
  `${n1(center[0] + radius * Math.cos((degrees * Math.PI) / 180))} ${n1(center[1] + radius * Math.sin((degrees * Math.PI) / 180))}`

/** The shared resource: one segment per container, the holder's color on a swapped one. */
function ring(resource: SceneResource, layout: Layout, o: SceneOptions, levels: UsageLevels | null): string {
  if (layout.ring === undefined) return ''
  const w = WORDS[o.lang]
  const center = layout.ring.center
  const tone = resource.holder === null ? WARN : colorOf(resource.holder)
  // Until a holder says which containers are in scope, the ring is a plain one.
  const names = resource.members.length > 0 ? resource.members : Array<string>(20).fill('')
  const share = 360 / names.length
  const gap = Math.min(4, share * 0.22)
  const segments = names
    .map((name, i) => {
      const from = i * share - 88
      const to = from + share - gap
      const fill = name !== '' && resource.swapped.includes(name) ? tone : '#3a4458'
      const title = name === '' ? '' : `<title>${esc(name)}</title>`
      const large = share - gap > 180 ? 1 : 0

      // A rim outside the segment says how hard the container works; the
      // segment's own color stays free to say its image was swapped.
      const load = name === '' ? 0 : (levels?.containers[name] ?? 0)
      const rimAt = RING_OUTER + 5
      const rim = load === 0
        ? ''
        : `<path d="M${polar(center, rimAt, from)}A${rimAt} ${rimAt} 0 ${large} 1 ${polar(center, rimAt, to)}" fill="none" stroke="${LOAD_TONES[load] ?? WARN}" stroke-width="3" stroke-linecap="round"/>`

      return `${rim}<path d="M${polar(center, RING_OUTER, from)}A${RING_OUTER} ${RING_OUTER} 0 ${large} 1 ${polar(center, RING_OUTER, to)}L${polar(center, RING_INNER, to)}A${RING_INNER} ${RING_INNER} 0 ${large} 0 ${polar(center, RING_INNER, from)}Z" fill="${fill}"${name === '' ? ' opacity=".55"' : ''}>${title}</path>`
    })
    .join('')
  const alarm = resource.isUrgent ? ASK : resource.phase === 'restoring' || resource.isStale ? WARN : 'none'
  const word = resource.holder !== null ? '' : resource.phase === 'restoring' ? w.restoring : w.free
  const note = resource.isUrgent ? w.urgent : resource.isStale ? w.stale : ''

  return `<circle cx="${center[0]}" cy="${center[1]}" r="${RING_INNER - 7}" fill="#111827" stroke="${alarm}" stroke-width="2" stroke-dasharray="5 6"/>${segments}<text x="${center[0]}" y="${center[1] + 4}" class="t st" text-anchor="middle">${esc(word)}</text>${note === '' ? '' : `<text x="${center[0]}" y="${center[1] + RING_OUTER + 46}" class="t st" text-anchor="middle" style="fill:${alarm}">${esc(note)}</text>`}<text x="${layout.ring.caption[0]}" y="${layout.ring.caption[1]}" class="t cap" text-anchor="middle">${esc(resource.name.toUpperCase())}</text>${resource.queue.length > 0 ? `<text x="${layout.ring.queueCaption[0]}" y="${layout.ring.queueCaption[1]}" class="t cap" text-anchor="middle">${esc(w.queue.toUpperCase())}</text>` : ''}`
}

const move = (from: Point, to: Point) =>
  `<animateTransform attributeName="transform" type="translate" from="${n1(from[0])} ${n1(from[1])}" to="${n1(to[0])} ${n1(to[1])}" dur="0.9s" calcMode="spline" keyTimes="0;1" keySplines=".3 0 .2 1" fill="freeze"/>`

function spark(from: Point, to: Point, color: string): string {
  const path = `M${n1(from[0])} ${n1(from[1])}L${n1(to[0])} ${n1(to[1])}`
  const fly = `<animateMotion dur="0.9s" path="${path}" fill="freeze"/><animate attributeName="opacity" values="1;1;0" keyTimes="0;.85;1" dur="0.9s" fill="freeze"/>`

  return `<circle r="11" fill="${color}" opacity=".25">${fly}</circle><circle r="5" fill="${color}">${fly}</circle>`
}

function card(a: SceneAgent, at: Point, layout: Layout, o: SceneOptions, cores: number): string {
  const w = WORDS[o.lang]
  const rows = [
    `${w.state[a.state]}${a.isAsleep ? ` · ${w.asleep}` : ''} · ${w.since} ${clock(a.since, o.utcOffsetMinutes)}`,
    ...(a.branch === null ? [] : [`${w.branch}: ${shorten(a.branch, 30)}`]),
    ...(a.lastAction === '' ? [] : [`${w.last}: ${shorten(a.lastAction, 30)}`]),
    ...(a.prUrl === undefined ? [] : [shorten(a.prUrl.replace(/^https?:\/\//, ''), 36)]),
    ...(a.usage === undefined ? [] : [`CPU ${usageText(a.usage, cores).replace(' · ', ' · RAM ')}`]),
  ]
  const width = 252
  const height = 30 + rows.length * 14
  const x = Math.max(6, Math.min(layout.width - width - 6, at[0] - width / 2))
  const above = at[1] - 34 - height
  const y = above < 6 ? at[1] + 52 : above
  const lines = rows
    .map((row, i) => `<text x="${n1(x + 10)}" y="${n1(y + 36 + i * 14)}" class="t st">${esc(row)}</text>`)
    .join('')

  return `<g class="tip"><rect x="${n1(x)}" y="${n1(y)}" width="${width}" height="${height}" rx="7" fill="#161d2c" stroke="${colorOf(a.id)}" stroke-opacity=".7"/><text x="${n1(x + 10)}" y="${n1(y + 19)}" class="t nm" fill="${colorOf(a.id)}">${esc(shorten(a.id, 34))}</text>${lines}</g>`
}

function coordinatorBall(stage: Stage, layout: Layout, o: SceneOptions, questions: number): string {
  if (stage.coordinator === null) return ''
  const w = WORDS[o.lang]
  const [x, y] = layout.coordinator
  const ring = questions > 0 ? ASK : '#e7ebf2'
  const pulse = questions > 0
    ? `<circle r="36" fill="none" stroke="${ASK}" stroke-width="2"><animate attributeName="r" values="36;62" dur="1.1s" repeatCount="indefinite"/><animate attributeName="opacity" values="1;0" dur="1.1s" repeatCount="indefinite"/></circle>`
    : ''
  const badge = questions > 0
    ? `<circle cx="24" cy="-24" r="11" fill="${ASK}"/><text x="24" y="-19.5" class="t" font-size="12" font-weight="700" text-anchor="middle" fill="#1a0610">${questions}</text>`
    : ''

  return `<g transform="translate(${x},${y})"><circle r="46" fill="#e7ebf2" opacity=".12" filter="url(#blur)"/>${pulse}<g><circle r="36" fill="none" stroke="#5b6780" stroke-width="1.5" stroke-dasharray="3 7"/><animateTransform attributeName="transform" type="rotate" from="0" to="360" dur="30s" repeatCount="indefinite"/></g><circle r="28" fill="#0f1420" stroke="${ring}" stroke-width="2"/><circle r="9" fill="#e7ebf2"/>${badge}<text y="58" class="t nm" text-anchor="middle" fill="#e7ebf2">${esc(shorten(stage.coordinator.id, layout.nameMax))}</text><text y="71" class="t st" text-anchor="middle"${questions > 0 ? ` style="fill:${ASK}"` : ''}>${esc(questions > 0 ? w.waiting(questions) : w.allGood)}</text></g>`
}

/** One document for one stage: no script, every motion baked in as SMIL. */
export function renderScene(stage: Stage, layout: Layout, skin: Skin, o: SceneOptions): string {
  const w = WORDS[o.lang]
  const { width, height } = layout
  const hasLead = stage.coordinator !== null
  const origin = layout.coordinator
  // A stage kept from before a reload may predate a field: read it as absent.
  const levels = stage.levels ?? null
  let links = ''
  let balls = ''
  let tips = ''
  let sparks = ''
  let unplaced = 0

  for (const a of stage.agents) {
    const place = stage.places[a.id]
    const at = pointOf(layout, place)
    if (at === undefined || place === undefined) {
      unplaced += 1
      continue
    }
    const was = pointOf(layout, stage.prevPlaces[a.id]) ?? (hasLead ? origin : undefined)
    // The holder stands inside the ring: its name goes beneath the ring.
    const drop = place.zone === 'holder' ? 70 : 0
    const color = colorOf(a.id)
    const isDim = (o.focus && !a.needsAttention) || a.isAsleep
    const fade = a.state === 'done' ? '<animate attributeName="opacity" values="1;0" dur="1.3s" fill="freeze"/>' : ''
    const travel = was !== undefined && (was[0] !== at[0] || was[1] !== at[1]) ? move(was, at) : ''
    const label = o.labels
      ? `<text y="${43 + drop}" class="t st" text-anchor="middle">${esc(a.isAsleep ? w.asleep : w.state[a.state])}</text>`
      : ''

    const cost = gauges(levels?.agents[a.id], color, (o.labels ? 49 : 37) + drop)
    balls += `<g transform="translate(${at[0]},${at[1]})"${isDim ? ` opacity="${a.isAsleep ? 0.35 : 0.2}"` : ''}>${travel}${fade}${cost}<g transform="scale(${layout.scale})">${skin.glyph(a, { color, ...(place.zone === 'queue' ? { queueIndex: place.index } : {}) })}</g><text y="${31 + drop}" class="t nm" text-anchor="middle" fill="${color}">${esc(shorten(a.id, layout.nameMax))}</text>${label}</g>`
    tips += `<g class="hit"><circle cx="${at[0]}" cy="${at[1]}" r="24" fill="#000" fill-opacity="0"/>${card(a, at, layout, o, levels?.cores ?? 1)}</g>`

    if (hasLead && o.links && place.zone === 'work' && a.state !== 'idle') {
      const isAsk = a.state === 'question'
      links += `<line x1="${origin[0]}" y1="${origin[1]}" x2="${at[0]}" y2="${at[1]}" stroke="${isAsk ? ASK : '#8e99ad'}" stroke-opacity="${isAsk ? 0.6 : 0.14}"/>`
    }
  }

  if (hasLead) {
    for (const s of stage.sparks) {
      const at = pointOf(layout, stage.places[s.agent])
      if (at === undefined) continue
      sparks += s.kind === 'ask' ? spark(at, origin, ASK) : spark(origin, at, '#ffffff')
    }
  }

  const count = (state: AgentState) => stage.agents.filter(a => a.state === state).length
  const questions = count('question')
  const live = stage.agents.filter(a => a.state !== 'done').length
  const hudTop = `${hasLead ? `1 ${w.coordinatorName} · ` : ''}${w.worktrees(live)}${questions > 0 ? ` · ${w.questions} ${questions}` : ''}${unplaced > 0 ? ` · ${w.more(unplaced)}` : ''}`
  const shared = stage.resource
  const hudResource = shared === null
    ? ''
    : `${shared.name}: ${shared.holder ?? (shared.phase === 'restoring' ? w.restoring : w.free)} · ${w.queue} ${shared.queue.length}`
  const bottomStates: AgentState[] = ['research', 'coding', 'question', 'queue', 'testing', 'failed', 'pr', 'idle']
  const hudBottom = bottomStates.map(s => `${w.short[s]} ${count(s)}`).join(' · ')
  const caption = (at: Point, text: string) =>
    `<text x="${at[0]}" y="${at[1]}" class="t cap" text-anchor="middle">${esc(text)}</text>`

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${o.pixelWidth}" height="${o.pixelHeight}" viewBox="0 0 ${width} ${height}" role="img">
<style>
.t{font-family:"Geist Mono",ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
.nm{font-size:10.5px;font-weight:600}.st{font-size:9px;fill:#9aa5b8}
.cap{font-size:10px;letter-spacing:.14em;fill:#7c879b}.hud{font-size:11.5px;fill:#c7cfdc}
.tip{opacity:0;pointer-events:none;transition:opacity .15s}
.hit:hover .tip{opacity:1}
</style>
<defs><radialGradient id="bg" cx="50%" cy="50%" r="70%"><stop offset="0" stop-color="#161d2c"/><stop offset="1" stop-color="#0b0f17"/></radialGradient>
<pattern id="dots" width="22" height="22" patternUnits="userSpaceOnUse"><circle cx="1" cy="1" r="1" fill="#1d2534"/></pattern>${skin.defs}</defs>
<rect width="${width}" height="${height}" fill="url(#bg)"/><rect width="${width}" height="${height}" fill="url(#dots)"/>
${hasLead ? caption(layout.captions.coordinator, w.coordinator) : ''}${caption(layout.captions.work, w.work)}${caption(layout.captions.pr, w.pr)}
<g>${links}</g>
${shared === null ? '' : ring(shared, layout, o, levels)}
${coordinatorBall(stage, layout, o, questions)}
<g>${balls}</g><g>${sparks}</g>
<text x="${layout.hudTop[0]}" y="${layout.hudTop[1]}" class="t hud">${esc(hudTop)}</text>
${hudResource === '' ? '' : `<text x="${layout.width - layout.hudTop[0]}" y="${layout.hudTop[1] + (layout.kind === 'narrow' ? 16 : 0)}" class="t hud" text-anchor="end">${esc(hudResource)}</text>`}
<text x="${layout.hudBottom[0]}" y="${layout.hudBottom[1]}" class="t st">${esc(hudBottom)}</text>
${meters(levels, layout.meters)}
<g>${tips}</g>
</svg>`
}

/** What a reader who cannot see the drawing is told. */
export function describeScene(stage: Stage, lang: Lang): string {
  const w = WORDS[lang]

  return stage.agents.map(a => `${a.id}: ${w.state[a.state]}`).join(', ') || w.worktrees(0)
}
