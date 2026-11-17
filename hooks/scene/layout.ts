export type Point = readonly [number, number]

/** Where each zone sits for one shape of pane. A skin never needs to know. */
export type Layout = {
  /** `wide` flows left to right as the mockup does, `narrow` top to bottom. */
  kind: 'wide' | 'narrow'
  width: number
  height: number
  coordinator: Point
  work: (slot: number) => Point
  pr: (slot: number) => Point
  /** Present when the scene shows a shared resource: its ring and its queue. */
  ring?: { center: Point; queue: (index: number) => Point; caption: Point; queueCaption: Point }
  captions: { coordinator: Point; work: Point; pr: Point }
  hudTop: Point
  hudBottom: Point
  /** Where the CPU and RAM meters start: their left end, on a text baseline. */
  meters: Point
  /** Characters of an agent's name that fit under its ball. */
  nameMax: number
  /** The same in the PR zone, where agents may stand closer side by side. */
  prNameMax: number
  /** How large an agent is drawn. */
  scale: number
}

const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value))

/** The least room one agent needs: its ball, its name and its state. */
const CELL_WIDTH = 136
const CELL_HEIGHT = 74
/** Places per zone; the stage seats agents into the same counts. */
const WORK_PLACES = 15
const PR_PLACES = 5
const namesIn = (gap: number) => clamp(Math.floor(gap / 6.8), 14, 26)

/** How wide the two meters are drawn, side by side. */
export const METERS_WIDTH = 350

/** The ring's outer radius, and how far from its center the queue stands. */
export const RING_OUTER = 82
export const RING_INNER = 65
const QUEUE_RADIUS = 148

/** The queue curls round the ring's left side, first in line at nine o'clock. */
const queueAt = (center: Point) => (index: number): Point => {
  const angle = ((180 + index * 27) * Math.PI) / 180

  return [Math.round(center[0] + QUEUE_RADIUS * Math.cos(angle)), Math.round(center[1] + QUEUE_RADIUS * Math.sin(angle))]
}

/** Left to right, as the mockup: coordinator, work, PR. */
function wide(width: number, height: number, hasRing: boolean): Layout | undefined {
  const left = hasRing ? 185 : 200
  const ringX = width - 335
  const right = hasRing ? ringX - 208 : width - 210
  if (hasRing && height < 522) return undefined
  const columns = clamp(Math.floor((right - left) / CELL_WIDTH), 0, 5)
  if (columns < 2) return undefined
  const rows = Math.ceil(WORK_PLACES / columns)
  if (height < 115 + (rows - 1) * CELL_HEIGHT + 93) return undefined
  if (height < 125 + (PR_PLACES - 1) * 64 + 107) return undefined
  const middle = (left + right) / 2
  const columnGap = Math.min(190, (right - left) / columns)
  const rowGap = clamp((height - 115 - 93) / (rows - 1), CELL_HEIGHT, 120)
  const prGap = clamp((height - 125 - 107) / (PR_PLACES - 1), 64, 100)

  return {
    kind: 'wide',
    width,
    height,
    coordinator: [95, Math.round(height / 2) + 10],
    work: i => [
      Math.round(middle + ((i % columns) - (columns - 1) / 2) * columnGap),
      Math.round(115 + Math.floor(i / columns) * rowGap),
    ],
    pr: i => [width - 110, Math.round(125 + i * prGap)],
    ...(hasRing
      ? {
          ring: {
            center: [ringX, Math.round(height / 2) + 10] as const,
            queue: queueAt([ringX, Math.round(height / 2) + 10]),
            caption: [ringX, 78] as const,
            queueCaption: [ringX - 170, 78] as const,
          },
        }
      : {}),
    captions: { coordinator: [95, 78], work: [Math.round(middle), 78], pr: [width - 110, 78] },
    hudTop: [24, 36],
    hudBottom: [24, height - 20],
    meters: [width - 24 - METERS_WIDTH, height - 20],
    nameMax: namesIn(columnGap),
    // The PR zone is a column with room on both sides of each name.
    prNameMax: namesIn(columnGap),
    scale: 0.76,
  }
}

/** Top to bottom for a docked pane: coordinator, work, PR. */
function narrow(width: number, height: number, hasRing: boolean): Layout | undefined {
  const columns = clamp(Math.floor((width - 30) / CELL_WIDTH), 0, 5)
  if (columns < 3) return undefined
  const rows = Math.ceil(WORK_PLACES / columns)
  const top = 262
  // The ring and its queue take a band of their own between work and PR.
  const bottom = height - (hasRing ? 496 : 196)
  if (bottom - top < (rows - 1) * CELL_HEIGHT) return undefined
  const columnGap = Math.min(190, (width - 30) / columns)
  const rowGap = clamp((bottom - top) / (rows - 1), CELL_HEIGHT, 120)
  const prGap = Math.min(120, (width - 30) / PR_PLACES)
  const middle = width / 2
  const workEnd = top + (rows - 1) * rowGap
  const ringAt: Point = [Math.round(middle + 60), Math.round((workEnd + 50 + height - 150) / 2 + 25)]

  return {
    kind: 'narrow',
    width,
    height,
    coordinator: [Math.round(middle), 122],
    work: i => [
      Math.round(middle + ((i % columns) - (columns - 1) / 2) * columnGap),
      Math.round(top + Math.floor(i / columns) * rowGap),
    ],
    pr: i => [Math.round(middle + (i - (PR_PLACES - 1) / 2) * prGap), height - 88],
    ...(hasRing
      ? {
          ring: {
            center: ringAt,
            queue: queueAt(ringAt),
            caption: [ringAt[0], ringAt[1] - 97] as const,
            queueCaption: [ringAt[0] - QUEUE_RADIUS, ringAt[1] + 66] as const,
          },
        }
      : {}),
    captions: {
      coordinator: [Math.round(middle), 62],
      work: [Math.round(middle), 214],
      pr: [Math.round(middle), height - 136],
    },
    hudTop: [16, 28],
    hudBottom: [16, height - 16],
    meters: [16, height - 34],
    nameMax: namesIn(columnGap),
    // The PR zone is a row of five: a name must leave room for the next one's.
    prNameMax: clamp(Math.floor(prGap / 6.6), 8, namesIn(columnGap)),
    scale: 0.76,
  }
}

/** Where the zones of one agent's plan sit; steps move through them. */
export type PlanLayout = {
  kind: 'wide' | 'narrow'
  width: number
  height: number
  agent: Point
  todo: (slot: number) => Point
  active: (slot: number) => Point
  gate: Point
  done: (slot: number) => Point
  /** The gate's line, drawn only while a step waits at it. */
  gateLine: readonly [Point, Point]
  captions: { agent: Point; todo: Point; active: Point; done: Point; gate: Point }
  /** Where the count of steps without a place goes, by zone. */
  more: { todo: Point; done: Point }
  /** Present when there is room for the shared resource's ring. */
  ring?: NonNullable<Layout['ring']>
  hudTop: Point
  hudBottom: Point
  meters: Point
  /** Characters of a step's text that fit under its ball. */
  nameMax: number
  scale: number
}

/** Left to right: the agent, what waits, what is in progress, what is done. */
function planWide(width: number, height: number, hasRing: boolean): PlanLayout | undefined {
  const ringRoom = hasRing && width >= 1060 && height >= 430 ? 270 : 0
  const right = width - ringRoom
  if (right < 640 || height < 384) return undefined
  const from = 100
  const to = right - 90
  const at = (share: number) => Math.round(from + (to - from) * share)
  const middle = Math.round((124 + height - 92) / 2)
  const rowGap = clamp((height - 124 - 92) / 3, 56, 86)
  const row = (i: number) => Math.round(middle + (i - 1.5) * rowGap)
  const gateX = at(0.79)
  const ringAt: Point = [width - 140, middle + 6]

  return {
    kind: 'wide',
    width,
    height,
    agent: [from, middle],
    // A little high, so the line to the step in progress passes between two rows.
    todo: i => [at(0.3), row(i) - 10],
    active: i => [at(0.58), middle + i * 88],
    gate: [gateX, middle],
    done: i => [to, row(i)],
    gateLine: [[gateX, row(0) - 26], [gateX, row(3) + 26]],
    captions: { agent: [from, 78], todo: [at(0.3), 78], active: [at(0.58), 78], done: [to, 78], gate: [gateX, row(3) + 46] },
    more: { todo: [at(0.3), row(3) + 54], done: [to, row(3) + 54] },
    ...(ringRoom > 0
      ? { ring: { center: ringAt, queue: queueAt(ringAt), caption: [ringAt[0], 78] as const, queueCaption: [ringAt[0], 78] as const } }
      : {}),
    hudTop: [24, 36],
    hudBottom: [24, height - 20],
    meters: [width - 24 - METERS_WIDTH, height - 20],
    nameMax: clamp(Math.floor(((to - from) * 0.21) / 5.6), 12, 24),
    scale: 0.76,
  }
}

/** Top to bottom for a docked pane, in the same order. */
function planNarrow(width: number, height: number): PlanLayout | undefined {
  if (width < 424 || height < 700) return undefined
  const middle = Math.round(width / 2)
  const gap = Math.min(130, (width - 40) / 4)
  const across = (i: number) => Math.round(middle + (i - 1.5) * gap)
  const from = 128
  const to = height - 112
  const at = (share: number) => Math.round(from + (to - from) * share)

  return {
    kind: 'narrow',
    width,
    height,
    agent: [middle, from],
    todo: i => [across(i), at(0.3)],
    active: i => [Math.round(middle + i * 120), at(0.57)],
    gate: [middle, at(0.78)],
    done: i => [across(i), to],
    gateLine: [[across(0) - 30, at(0.78)], [across(3) + 30, at(0.78)]],
    captions: {
      agent: [middle, 62],
      todo: [middle, at(0.3) - 38],
      active: [middle, at(0.57) - 44],
      done: [middle, to - 38],
      gate: [across(3) + 10, at(0.78) - 12],
    },
    more: { todo: [middle, at(0.3) + 52], done: [middle, to + 52] },
    hudTop: [16, 28],
    hudBottom: [16, height - 16],
    meters: [16, height - 34],
    nameMax: clamp(Math.floor(gap / 6.4) - 1, 10, 22),
    scale: 0.76,
  }
}

/**
 * A pane says its size in text cells; a drawing is sized in CSS pixels. A
 * cell of the body measured this wide and this tall on the desktop surface.
 */
export const COLUMN_PIXELS = 8
export const ROW_PIXELS = 20
/** Pixels the switches above the scene take, with the gap beneath them. */
export const CHROME_PIXELS = 44

/** How much the scene may be magnified or shrunk to suit the pane. */
const ZOOMS = [1.3, 1.2, 1.1, 1, 0.9, 0.8, 0.7, 0.6]

export type Fit = { layout: Layout; pixelWidth: number; pixelHeight: number }

/**
 * The layout for a pane of this many columns and rows. The drawing takes the
 * pane's whole body: the scene is laid out at the pane's own proportions, at
 * the largest zoom at which every place still has room, in whichever flow
 * suits the shape.
 */
export function fitLayout(bodyColumns: number, bodyRows: number, hasRing = false): Fit {
  const pixelWidth = Math.max(240, Math.floor(bodyColumns * COLUMN_PIXELS))
  const pixelHeight = Math.max(240, Math.floor(bodyRows * ROW_PIXELS) - CHROME_PIXELS)
  const flows = pixelWidth >= pixelHeight * 1.2 ? [wide, narrow] : [narrow, wide]
  for (const zoom of ZOOMS) {
    const width = Math.round(pixelWidth / zoom)
    const height = Math.round(pixelHeight / zoom)
    for (const flow of flows) {
      const layout = flow(width, height, hasRing)
      if (layout !== undefined) return { layout, pixelWidth, pixelHeight }
    }
  }
  // A pane too small for either flow: the narrow one at its least size,
  // which the pane then scrolls.
  const least = (hasRing ? narrow(480, 1060, true) : narrow(480, 760, false)) as Layout

  return { layout: least, pixelWidth, pixelHeight: Math.round((pixelWidth * least.height) / least.width) }
}

export type PlanFit = { layout: PlanLayout; pixelWidth: number; pixelHeight: number }

/** The plan's layout for a pane of this many columns and rows, as `fitLayout` finds the team's. */
export function fitPlan(bodyColumns: number, bodyRows: number, hasRing = false): PlanFit {
  const pixelWidth = Math.max(240, Math.floor(bodyColumns * COLUMN_PIXELS))
  const pixelHeight = Math.max(240, Math.floor(bodyRows * ROW_PIXELS) - CHROME_PIXELS)
  const isWide = pixelWidth >= pixelHeight * 1.2
  for (const zoom of ZOOMS) {
    const width = Math.round(pixelWidth / zoom)
    const height = Math.round(pixelHeight / zoom)
    const wide = planWide(width, height, hasRing)
    const narrow = planNarrow(width, height)
    const layout = isWide ? (wide ?? narrow) : (narrow ?? wide)
    if (layout !== undefined) return { layout, pixelWidth, pixelHeight }
  }
  const least = planNarrow(480, 760) as PlanLayout

  return { layout: least, pixelWidth, pixelHeight: Math.round((pixelWidth * least.height) / least.width) }
}

/** One source's tile on the shelf. */
export type Tile = { width: number; height: number; gap: number }

/**
 * Where the parts of one agent's research sit: the agent in the middle, its
 * probes on an orbit round it, the shelf of sources, and the line of how
 * many searches ran at once.
 */
export type ResearchLayout = {
  kind: 'wide' | 'narrow'
  width: number
  height: number
  /** The agent, at the middle of the orbit. */
  center: Point
  /** Half the orbit's width, and half its height. */
  orbit: { rx: number; ry: number }
  /** Where the probe in a place of the orbit stands, counted from 0. */
  probe: (place: number) => Point
  /** The shelf's top left corner, and how many tiles fit it. */
  shelf: { x: number; y: number; columns: number; rows: number; tile: Tile }
  /** The box the sparkline is drawn in. */
  spark: { x: number; y: number; width: number; height: number }
  captions: { shelf: Point; spark: Point }
  hudTop: Point
  /** The line of what runs now, and which way its text runs from there. */
  counter: { at: Point; anchor: 'start' | 'end' }
  hudBottom: Point
  meters: Point
  /** Characters per line of a probe's label, and of a domain on a tile. */
  nameMax: number
  tileMax: number
  scale: number
}

/** Places on the orbit; the stage seats probes into the same count. */
export const ORBIT_PLACES = 8
/** The orbit's places in the order they fill, so a few probes spread out; none is straight above or below the agent. */
const ORBIT_ORDER = [0, 4, 2, 6, 3, 7, 1, 5]
/** How far a probe's three lines of text reach beyond its ball's middle, up or down. */
export const LABEL_REACH = 50
/** Width of one character of the scene's small type, with room for a wider fallback font. */
const CHAR = 6

const onOrbit = (center: Point, rx: number, ry: number) => (place: number): Point => {
  const degrees = -67.5 + (ORBIT_ORDER[((place % ORBIT_PLACES) + ORBIT_PLACES) % ORBIT_PLACES] ?? 0) * 45
  const angle = (degrees * Math.PI) / 180

  return [Math.round(center[0] + rx * Math.cos(angle)), Math.round(center[1] + ry * Math.sin(angle))]
}

/** The orbit's sides lie at cos 22.5° of its width from the middle, its top and bottom at that much of its height. */
const SIDE = Math.cos(Math.PI / 8)

/** Left to right: the agent and its orbit, then the shelf; the sparkline beneath. */
function researchWide(width: number, height: number): ResearchLayout | undefined {
  if (width < 880 || height < 500) return undefined
  const base: Tile = { width: 116, height: 20, gap: 8 }
  const columns = clamp(Math.floor((width * 0.3 + base.gap) / (base.width + base.gap)), 2, 4)
  const shelfX = width - 24 - (columns * (base.width + base.gap) - base.gap)
  const [left, right, top, bottom] = [24, shelfX - 36, 64, height - 112]
  const reach = (24 * CHAR) / 2 + 4
  const center: Point = [Math.round((left + right) / 2), Math.round((top + bottom) / 2)]
  const ry = clamp(((bottom - top) / 2 - LABEL_REACH) / SIDE, 100, 230)
  const rx = Math.round(clamp(Math.min(ry * 1.5, ((right - left) / 2 - reach) / SIDE), ry * 0.9, 340))
  // The two probes at the top, and the two at the bottom, have room for both their names.
  const nameMax = clamp(Math.floor((2 * Math.sin(Math.PI / 8) * rx - 8) / CHAR), 12, 24)
  const shelfY = 92

  return {
    kind: 'wide',
    width,
    height,
    center,
    orbit: { rx, ry: Math.round(ry) },
    probe: onOrbit(center, rx, Math.round(ry)),
    shelf: { x: shelfX, y: shelfY, columns, rows: Math.max(1, Math.floor((height - 48 - shelfY + base.gap) / (base.height + base.gap))), tile: base },
    spark: { x: 24, y: height - 82, width: Math.min(440, right - left), height: 34 },
    captions: { shelf: [shelfX, 78], spark: [24, height - 92] },
    hudTop: [24, 36],
    counter: { at: [width - 24, 36], anchor: 'end' },
    hudBottom: [24, height - 20],
    meters: [width - 24 - METERS_WIDTH, height - 20],
    nameMax,
    tileMax: Math.floor((base.width - 14) / CHAR),
    scale: 0.76,
  }
}

/** Top to bottom for a docked pane: the orbit, the sparkline, the shelf. */
function researchNarrow(width: number, height: number): ResearchLayout | undefined {
  if (width < 400 || height < 700) return undefined
  const wanted = clamp(Math.floor((width - 40) / 22), 14, 26)
  const rx = Math.round(clamp((width / 2 - 14 - (wanted * CHAR) / 2) / SIDE, 110, 280))
  const nameMax = Math.min(wanted, Math.floor((2 * Math.sin(Math.PI / 8) * rx - 8) / CHAR))
  // The orbit leaves the shelf room for four rows of sources at least.
  const ry = Math.round(clamp(Math.min(rx * 0.82, (height - 440) / (2 * SIDE)), 100, 210))
  const center: Point = [Math.round(width / 2), Math.round(60 + LABEL_REACH + SIDE * ry)]
  const sparkY = Math.round(center[1] + SIDE * ry + LABEL_REACH + 30)
  const gap = 8
  const columns = clamp(Math.floor((width - 32 + gap) / (116 + gap)), 2, 6)
  const tile: Tile = { width: Math.floor((width - 32 - (columns - 1) * gap) / columns), height: 20, gap }
  const shelfY = sparkY + 34 + 40
  const rows = Math.floor((height - 64 - shelfY + gap) / (tile.height + gap))
  if (rows < 2) return undefined

  return {
    kind: 'narrow',
    width,
    height,
    center,
    orbit: { rx, ry },
    probe: onOrbit(center, rx, ry),
    shelf: { x: 16, y: shelfY, columns, rows, tile },
    spark: { x: 16, y: sparkY, width: width - 32, height: 34 },
    captions: { shelf: [16, shelfY - 12], spark: [16, sparkY - 10] },
    hudTop: [16, 28],
    counter: { at: [16, 46], anchor: 'start' },
    hudBottom: [16, height - 16],
    meters: [16, height - 34],
    nameMax,
    tileMax: Math.floor((tile.width - 14) / CHAR),
    scale: 0.76,
  }
}

export type ResearchFit = { layout: ResearchLayout; pixelWidth: number; pixelHeight: number }

/** The research's layout for a pane of this many columns and rows, as `fitLayout` finds the team's. */
export function fitResearch(bodyColumns: number, bodyRows: number): ResearchFit {
  const pixelWidth = Math.max(240, Math.floor(bodyColumns * COLUMN_PIXELS))
  const pixelHeight = Math.max(240, Math.floor(bodyRows * ROW_PIXELS) - CHROME_PIXELS)
  const isWide = pixelWidth >= pixelHeight * 1.2
  for (const zoom of ZOOMS) {
    const width = Math.round(pixelWidth / zoom)
    const height = Math.round(pixelHeight / zoom)
    const layout = isWide ? (researchWide(width, height) ?? researchNarrow(width, height)) : (researchNarrow(width, height) ?? researchWide(width, height))
    if (layout !== undefined) return { layout, pixelWidth, pixelHeight }
  }
  const least = researchNarrow(480, 820) as ResearchLayout

  return { layout: least, pixelWidth, pixelHeight: Math.round((pixelWidth * least.height) / least.width) }
}
