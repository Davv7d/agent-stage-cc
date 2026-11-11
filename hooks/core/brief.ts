import type { Brief, Limit, Snapshot, UsageReport } from '../../types'
import type { NotifyEvents } from './config'
import { ownShare } from './usage'

const GB = 1024 ** 3

/**
 * What the band and the status line show: how loaded the machine is and how
 * much of that is the stage's, how much of the account's limits is left, and
 * what waits on the person.
 */
export function toBrief(shot: Snapshot, usage: UsageReport | null, limits: readonly Limit[]): Brief {
  const own = usage === null ? null : ownShare(usage)
  return {
    usage: usage === null
      ? null
      : {
          cpuPercent: Math.min(100, Math.round(usage.system.cpuPercent)),
          ramGb: Math.round((usage.system.ramBytes / GB) * 10) / 10,
          machineGb: Math.round(usage.machine.ramBytes / GB),
          own: { cpuPercent: Math.round(own?.cpuPercent ?? 0), ramGb: Math.round(((own?.ramBytes ?? 0) / GB) * 10) / 10 },
        },
    limits: limits.map(l => ({ ...l, percentUsed: Math.round(l.percentUsed) })),
    questions: shot.counts.question,
    failed: shot.counts.failed,
  }
}

export type BriefWords = {
  questions: string
  failedTests: string
  week: string
  agents: string
}

/** The tones a figure in the band takes; a view gives each its color. */
export type Tone = 'cpu' | 'ram' | 'ownCpu' | 'ownRam' | 'short' | 'long' | 'other' | 'low' | 'out' | 'ask' | 'bad'

/**
 * One figure in the band: the bare number, the tone that tells it apart,
 * and the words a pointer over it reveals.
 */
export type BandItem = { key: string; text: string; tone: Tone; hint: string }

/**
 * The band, narrow enough for a docked chat: bare figures in a fixed order,
 * each in its own color. CPU and memory come in pairs: the stage's own share
 * in a quieter shade, then the whole machine. Limits show what is left, not
 * what is used.
 */
export function bandItems(brief: Brief, words: BriefWords): BandItem[] {
  const items: BandItem[] = []
  if (brief.usage !== null) {
    const { cpuPercent, ramGb, machineGb, own } = brief.usage
    items.push({ key: 'own-cpu', text: `${own.cpuPercent}%`, tone: 'ownCpu', hint: `CPU ${words.agents}` })
    items.push({ key: 'cpu', text: `${cpuPercent}%`, tone: cpuPercent >= 80 ? 'low' : 'cpu', hint: 'CPU system' })
    items.push({ key: 'own-ram', text: own.ramGb.toFixed(1), tone: 'ownRam', hint: `RAM ${words.agents} GB` })
    items.push({
      key: 'ram',
      text: `${ramGb.toFixed(1)}/${machineGb}`,
      tone: machineGb > 0 && ramGb / machineGb >= 0.8 ? 'low' : 'ram',
      hint: 'RAM system GB',
    })
  }
  for (const limit of brief.limits) {
    const left = Math.max(0, 100 - limit.percentUsed)
    const isShort = limit.kind === 'five_hour'
    const isLong = limit.kind === 'seven_day'
    items.push({
      key: `limit-${limit.kind}`,
      text: `${left}%`,
      tone: left < 10 ? 'out' : left < 25 ? 'low' : isShort ? 'short' : isLong ? 'long' : 'other',
      // Short on purpose: the band is narrow and the hint pushes its row.
      hint: isShort ? '5h' : isLong ? words.week : limit.kind,
    })
  }
  if (brief.questions > 0) items.push({ key: 'questions', text: `?${brief.questions}`, tone: 'ask', hint: words.questions })
  if (brief.failed > 0) items.push({ key: 'failed', text: `!${brief.failed}`, tone: 'bad', hint: words.failedTests })

  return items
}

/** The same figures as one line of plain text, each with a short name: a status line has no hover. */
export function statusText(brief: Brief, words: BriefWords): string | undefined {
  const parts: string[] = []
  if (brief.usage !== null) {
    const { cpuPercent, ramGb, machineGb, own } = brief.usage
    parts.push(
      `CPU ${cpuPercent}% (${words.agents} ${own.cpuPercent}%)`,
      `RAM ${ramGb.toFixed(1)}/${machineGb} GB (${words.agents} ${own.ramGb.toFixed(1)})`,
    )
  }
  for (const limit of brief.limits) {
    const name = limit.kind === 'five_hour' ? '5h' : limit.kind === 'seven_day' ? words.week : limit.kind
    parts.push(`${name} ${Math.max(0, 100 - limit.percentUsed)}%`)
  }
  if (brief.questions > 0) parts.push(`${words.questions} ${brief.questions}`)
  if (brief.failed > 0) parts.push(`${words.failedTests} ${brief.failed}`)

  return parts.length === 0 ? undefined : parts.join(' · ')
}

/** Something that just happened on the stage and may be worth a notification. */
export type Notice =
  | { kind: 'question'; agent: string; isUrgent: boolean }
  | { kind: 'failed'; agent: string }
  | { kind: 'pr'; agent: string }
  | { kind: 'released'; resource: string; by: string }

/** What changed between two looks at the stage, of the kinds the person asked for. */
export function noticesBetween(prev: Snapshot, next: Snapshot, wanted: NotifyEvents): Notice[] {
  const was = new Map(prev.agents.map(a => [a.id, a.state]))
  const notices: Notice[] = []
  for (const a of next.agents) {
    const before = was.get(a.id)
    if (before === a.state) continue
    if (a.state === 'question' && wanted.question) {
      const blocks = next.resources.some(r => r.holder === a.id && r.queue.length > 0)
      notices.push({ kind: 'question', agent: a.id, isUrgent: blocks })
    }
    if (a.state === 'failed' && wanted.failed) notices.push({ kind: 'failed', agent: a.id })
    if (a.state === 'pr' && before !== undefined && wanted.pr) notices.push({ kind: 'pr', agent: a.id })
  }
  if (wanted.released) {
    for (const r of next.resources) {
      const held = prev.resources.find(p => p.name === r.name)?.holder
      if (held != null && r.holder === null) notices.push({ kind: 'released', resource: r.name, by: held })
    }
  }

  return notices
}
