import type { AgentRecord, ResourceRecord, ResourceView } from '../../types'

export const DEFAULT_RESOURCE = 'stack'

/** A holder quiet for this long is flagged in every view. */
export const STALE_AFTER_MS = 10 * 60_000

export const emptyResource = (name: string, at: number): ResourceRecord => ({
  v: 1, name, holder: null, heldSince: 0, releasedAt: 0, queue: [], members: [], baseline: {}, updatedAt: at,
})

export function isResourceRecord(value: unknown): value is ResourceRecord {
  if (typeof value !== 'object' || value === null) return false
  const r = value as Record<string, unknown>

  return (
    r.v === 1 &&
    typeof r.name === 'string' &&
    (r.holder === null || typeof r.holder === 'string') &&
    Array.isArray(r.queue) &&
    Array.isArray(r.members) &&
    typeof r.baseline === 'object' &&
    r.baseline !== null
  )
}

/** A resource's name as a file-safe word. */
export const resourceName = (name: string | undefined): string => {
  const safe = (name ?? '').trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '')

  return safe === '' ? DEFAULT_RESOURCE : safe.slice(0, 40)
}

/** What a person or a coordinator may ask of a resource. */
export type ResourceOp =
  | { kind: 'grant'; agent: string }
  | { kind: 'release' }
  | { kind: 'queue'; agent: string }
  | { kind: 'unqueue'; agent: string }
  | { kind: 'order'; agents: readonly string[] }
  | { kind: 'scope'; containers: readonly string[] }

/**
 * One request applied to a resource. `images` is what the machine says each
 * container runs now; a container new to the scope takes it as its baseline.
 */
export function applyOp(
  rec: ResourceRecord,
  op: ResourceOp,
  at: number,
  images: Readonly<Record<string, string>> = {},
): ResourceRecord {
  const next = step(rec, op, at, images)

  return { ...next, updatedAt: at }
}

function rebase(
  members: readonly string[],
  old: Readonly<Record<string, string>>,
  images: Readonly<Record<string, string>>,
): Record<string, string> {
  const baseline: Record<string, string> = {}
  for (const name of members) {
    const image = old[name] ?? images[name]
    if (image !== undefined) baseline[name] = image
  }

  return baseline
}

function step(
  rec: ResourceRecord,
  op: ResourceOp,
  at: number,
  images: Readonly<Record<string, string>>,
): ResourceRecord {
  switch (op.kind) {
    case 'grant':
      // A new holder starts from the stack as it stands: that is its baseline.
      return {
        ...rec,
        holder: op.agent,
        heldSince: rec.holder === op.agent ? rec.heldSince : at,
        queue: rec.queue.filter(id => id !== op.agent),
        baseline: rec.holder === op.agent ? rec.baseline : rebase(rec.members, {}, images),
      }
    case 'release':
      return rec.holder === null ? rec : { ...rec, holder: null, releasedAt: at }
    case 'queue':
      return rec.holder === op.agent || rec.queue.includes(op.agent)
        ? rec
        : { ...rec, queue: [...rec.queue, op.agent] }
    case 'unqueue':
      return { ...rec, queue: rec.queue.filter(id => id !== op.agent) }
    case 'order': {
      const first = op.agents.filter((id, i) => rec.queue.includes(id) && op.agents.indexOf(id) === i)

      return { ...rec, queue: [...first, ...rec.queue.filter(id => !first.includes(id))] }
    }
    case 'scope': {
      const members = [...new Set(op.containers.map(c => c.trim()).filter(c => c !== ''))].slice(0, 60)

      return { ...rec, members, baseline: rebase(members, rec.baseline, images) }
    }
  }
}

/**
 * Finds the agent a person meant: its exact id, else the one id that starts
 * with or contains the words given. Ambiguity is an answer, not a guess.
 */
export function resolveAgent(
  ids: readonly string[],
  query: string,
): { id: string } | { error: string } {
  const wanted = query.trim().toLowerCase()
  if (wanted === '') return { error: 'no agent named' }
  const exact = ids.find(id => id.toLowerCase() === wanted)
  if (exact !== undefined) return { id: exact }
  const starts = ids.filter(id => id.toLowerCase().startsWith(wanted))
  const found = starts.length > 0 ? starts : ids.filter(id => id.toLowerCase().includes(wanted))
  if (found.length === 1 && found[0] !== undefined) return { id: found[0] }
  const known = ids.length === 0 ? 'no agent has reported yet' : `known agents: ${ids.join(', ')}`

  return { error: found.length === 0 ? `no agent matches "${query}"; ${known}` : `"${query}" matches several agents: ${found.join(', ')}` }
}

/**
 * A resource as a view draws it. `images` is what the machine says each
 * member runs now, or null where nobody could ask it.
 */
export function toResourceView(
  rec: ResourceRecord,
  agents: readonly AgentRecord[],
  images: Readonly<Record<string, string>> | null,
  now: number,
): ResourceView {
  const live = new Set(agents.filter(a => a.state !== 'done').map(a => a.id))
  const holder = rec.holder !== null && live.has(rec.holder) ? rec.holder : null
  const queue = rec.queue.filter(id => live.has(id) && id !== holder)
  const swapped = images === null
    ? []
    : rec.members.filter(m => rec.baseline[m] !== undefined && images[m] !== undefined && images[m] !== rec.baseline[m])
  const who = agents.find(a => a.id === holder)

  return {
    ...rec,
    holder,
    queue,
    swapped,
    phase: holder !== null ? 'held' : swapped.length > 0 ? 'restoring' : 'free',
    isUrgent: who !== undefined && (who.state === 'question' || who.state === 'failed') && queue.length > 0,
    isStale: who !== undefined && now - who.updatedAt > STALE_AFTER_MS,
  }
}

const names = (ids: readonly string[]) => (ids.length === 0 ? 'nobody' : ids.join(', '))

/** A resource in words, for a model or a person at a prompt. */
export function describeResource(view: ResourceView): string {
  const held = view.holder === null
    ? view.phase === 'restoring' ? 'free, but swapped images are still in place' : 'free'
    : `held by ${view.holder}${view.isStale ? ' (quiet for a long time)' : ''}${view.isUrgent ? ' (waiting on the person while others queue)' : ''}`
  const scope = view.members.length === 0
    ? 'no containers reported in scope'
    : `${view.members.length} containers in scope, swapped: ${names(view.swapped)}`

  return `${view.name}: ${held}; queue: ${names(view.queue)}; ${scope}`
}
