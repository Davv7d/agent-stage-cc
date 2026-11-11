import type { SceneAgent } from './stage'

/** Pink is the person's attention on a question; red is an error. Reserved. */
export const ASK = '#ff5fa2'
export const BAD = '#ff6b6b'
/** Amber: something wants a look, but nobody is blocked on the person. */
export const WARN = '#fbbf24'

/** Agent colors: none close to the reserved pink or red. */
const PALETTE = [
  '#60a5fa', '#5eead4', '#38bdf8', '#a78bfa', '#86efac',
  '#fdba74', '#93c5fd', '#bef264', '#67e8f9', '#c4b5fd', '#818cf8',
]

/** One agent's color, the same in every session: it follows the name alone. */
export function colorOf(id: string): string {
  let hash = 2166136261
  for (let i = 0; i < id.length; i++) {
    hash = Math.imul(hash ^ id.charCodeAt(i), 16777619)
  }

  return PALETTE[(hash >>> 0) % PALETTE.length] ?? '#60a5fa'
}

export type GlyphContext = {
  color: string
  /** Position in a queue, from 0, when the agent waits in one. */
  queueIndex?: number
}

/**
 * A skin draws one agent in one state around the origin, within a radius of
 * about 30 units, as SVG markup without script. The scene and data stay the
 * same under every skin.
 */
export type Skin = {
  name: string
  /** Shared `<defs>` content the glyphs refer to. */
  defs: string
  glyph: (agent: SceneAgent, context: GlyphContext) => string
}
