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
export const METERS_WIDTH = 300

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
