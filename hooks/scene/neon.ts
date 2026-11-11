import { ASK, BAD } from './skin'
import type { Skin } from './skin'

const loop = (attribute: string, values: string, dur: number, begin = 0) =>
  `<animate attributeName="${attribute}" values="${values}" dur="${dur}s" begin="${begin}s" repeatCount="indefinite"/>`

const letter = (text: string, fill: string) =>
  `<text y="6.5" class="t" font-size="18" font-weight="700" text-anchor="middle" fill="${fill}">${text}</text>`

/** The default skin: a glowing ball whose inside shows the state. */
export const neon: Skin = {
  name: 'neon',
  defs: '<filter id="blur" x="-80%" y="-80%" width="260%" height="260%"><feGaussianBlur stdDeviation="8"/></filter>',
  glyph(agent, { color, queueIndex }) {
    const state = agent.state
    const tone = state === 'question' ? ASK : state === 'failed' ? BAD : color
    const isDim = state === 'idle' || state === 'queue'
    let g = `<circle r="27" fill="${tone}" opacity="${isDim ? 0.1 : 0.26}" filter="url(#blur)"/>`

    if (state === 'question' || state === 'failed') {
      g += [0, 0.9]
        .map(b => `<circle r="22" fill="none" stroke="${tone}" stroke-width="2">${loop('r', '22;46', 1.8, b)}${loop('opacity', '.9;0', 1.8, b)}</circle>`)
        .join('')
    }
    g += `<circle r="22" fill="${state === 'question' ? ASK : '#0f1420'}" stroke="${tone}" stroke-width="1.8"${state === 'queue' ? ' stroke-dasharray="4 6"' : ''}${state === 'idle' ? ' stroke-opacity=".45"' : ''}/>`

    switch (state) {
      case 'idle':
        g += `<circle r="3" fill="${color}" opacity=".45"/>`
        break
      case 'research':
        g += `<g><path d="M0 0L0 -22A22 22 0 0 1 19 -11Z" fill="${color}" opacity=".5"/><animateTransform attributeName="transform" type="rotate" from="0" to="360" dur="2.4s" repeatCount="indefinite"/></g><circle r="2.5" fill="${color}"/>`
        break
      case 'coding':
        g += [24, 15, 20, 10]
          .map((w, i) => `<rect x="-12" y="${-11 + i * 6}" height="2.8" rx="1.4" width="4" fill="${color}">${loop('width', `4;${w};${w};4`, 2.4, i * 0.3)}</rect>`)
          .join('')
        break
      case 'queue':
        g += letter(`#${(queueIndex ?? 0) + 1}`, color)
        break
      case 'testing':
        g += `<path d="M-5 -8L8 0L-5 8Z" fill="${color}"/><circle r="3" fill="#fff"><animateMotion dur="1.6s" repeatCount="indefinite" path="M-30 0a30 30 0 1 0 60 0a30 30 0 1 0 -60 0"/></circle>`
        break
      case 'failed':
        g += letter('!', BAD)
        break
      case 'question':
        g += letter('?', '#1a0610')
        break
      case 'pr':
      case 'done':
        g += `<path d="M-9 0l6 6 12-13" fill="none" stroke="${color}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>`
        break
    }

    return g
  },
}
