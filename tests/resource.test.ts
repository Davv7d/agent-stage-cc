import { expect, test } from 'claude-code/testing'

import type { AgentRecord, AgentState } from '../types'
import { parseInspect } from '../hooks/core/docker'
import {
  applyOp,
  describeResource,
  emptyResource,
  resolveAgent,
  resourceName,
  STALE_AFTER_MS,
  toResourceView,
} from '../hooks/core/resource'

const agent = (id: string, state: AgentState = 'coding', updatedAt = 0): AgentRecord => ({
  v: 1, id, worktree: `/w/${id}`, branch: null, sessionId: 's', isLive: true, role: 'agent',
  state, since: 0, lastAction: '', lastActionAt: 0, promptAt: 0, updatedAt,
})
const fresh = () => emptyResource('stack', 0)

test('granting takes the agent out of the queue and starts its hold', async () => {
  let rec = applyOp(fresh(), { kind: 'queue', agent: 'a' }, 10)
  rec = applyOp(rec, { kind: 'queue', agent: 'b' }, 20)
  rec = applyOp(rec, { kind: 'queue', agent: 'a' }, 30)
  expect(rec.queue).toEqual(['a', 'b'])
  rec = applyOp(rec, { kind: 'grant', agent: 'a' }, 40)
  expect(rec.holder).toBe('a')
  expect(rec.heldSince).toBe(40)
  expect(rec.queue).toEqual(['b'])
  // The holder does not queue for what it holds.
  expect(applyOp(rec, { kind: 'queue', agent: 'a' }, 50).queue).toEqual(['b'])
})

test('release frees the resource and gives it to nobody', async () => {
  let rec = applyOp(fresh(), { kind: 'grant', agent: 'a' }, 10)
  rec = applyOp(applyOp(rec, { kind: 'queue', agent: 'b' }, 20), { kind: 'release' }, 30)
  expect(rec.holder).toBe(null)
  expect(rec.releasedAt).toBe(30)
  // Who goes next is the person's or the coordinator's call.
  expect(rec.queue).toEqual(['b'])
})

test('the queue can be reordered and left', async () => {
  let rec = fresh()
  for (const id of ['a', 'b', 'c']) rec = applyOp(rec, { kind: 'queue', agent: id }, 1)
  expect(applyOp(rec, { kind: 'order', agents: ['c', 'a'] }, 2).queue).toEqual(['c', 'a', 'b'])
  expect(applyOp(rec, { kind: 'order', agents: ['x', 'b', 'b'] }, 2).queue).toEqual(['b', 'a', 'c'])
  expect(applyOp(rec, { kind: 'unqueue', agent: 'b' }, 2).queue).toEqual(['a', 'c'])
})

test('a swapped image is told by the baseline taken when the scope was given', async () => {
  let rec = applyOp(fresh(), { kind: 'grant', agent: 'a' }, 10)
  rec = applyOp(rec, { kind: 'scope', containers: ['db', 'api', 'api', ' '] }, 20, { db: 'sha:1', api: 'sha:2' })
  expect(rec.members).toEqual(['db', 'api'])
  expect(rec.baseline).toEqual({ db: 'sha:1', api: 'sha:2' })
  const agents = [agent('a', 'testing'), agent('b')]
  expect(toResourceView(rec, agents, { db: 'sha:1', api: 'sha:9' }, 30).swapped).toEqual(['api'])
  // Without the machine's word nothing is claimed swapped.
  expect(toResourceView(rec, agents, null, 30).swapped).toEqual([])
  // Adding to the scope keeps the baselines already taken.
  rec = applyOp(rec, { kind: 'scope', containers: ['db', 'api', 'web'] }, 40, { api: 'sha:9', web: 'sha:3' })
  expect(rec.baseline).toEqual({ db: 'sha:1', api: 'sha:2', web: 'sha:3' })
})

test('a new holder starts from the stack as it stands', async () => {
  let rec = applyOp(fresh(), { kind: 'scope', containers: ['api'] }, 10, { api: 'sha:1' })
  rec = applyOp(rec, { kind: 'grant', agent: 'b' }, 20, { api: 'sha:7' })
  expect(rec.baseline).toEqual({ api: 'sha:7' })
})

test('free, held and restoring follow the holder and the images', async () => {
  let rec = applyOp(fresh(), { kind: 'scope', containers: ['api'] }, 10, { api: 'sha:1' })
  const agents = [agent('a', 'testing'), agent('b')]
  expect(toResourceView(rec, agents, { api: 'sha:1' }, 20).phase).toBe('free')
  rec = applyOp(rec, { kind: 'grant', agent: 'a' }, 30, { api: 'sha:1' })
  expect(toResourceView(rec, agents, { api: 'sha:2' }, 40).phase).toBe('held')
  rec = applyOp(rec, { kind: 'release' }, 50)
  expect(toResourceView(rec, agents, { api: 'sha:2' }, 60).phase).toBe('restoring')
  expect(toResourceView(rec, agents, { api: 'sha:1' }, 70).phase).toBe('free')
})

test('a question from the holder is urgent only while others wait', async () => {
  let rec = applyOp(fresh(), { kind: 'grant', agent: 'a' }, 10)
  expect(toResourceView(rec, [agent('a', 'question'), agent('b')], null, 20).isUrgent).toBe(false)
  rec = applyOp(rec, { kind: 'queue', agent: 'b' }, 30)
  expect(toResourceView(rec, [agent('a', 'question'), agent('b')], null, 40).isUrgent).toBe(true)
  expect(toResourceView(rec, [agent('a', 'testing'), agent('b')], null, 40).isUrgent).toBe(false)
})

test('a quiet holder is flagged, a gone one no longer holds', async () => {
  const rec = applyOp(applyOp(fresh(), { kind: 'grant', agent: 'a' }, 10), { kind: 'queue', agent: 'b' }, 20)
  expect(toResourceView(rec, [agent('a', 'idle', 0), agent('b')], null, STALE_AFTER_MS + 1).isStale).toBe(true)
  expect(toResourceView(rec, [agent('a', 'idle', 0), agent('b')], null, 1000).isStale).toBe(false)
  const gone = toResourceView(rec, [agent('b')], null, 1000)
  expect(gone.holder).toBe(null)
  expect(gone.queue).toEqual(['b'])
  // A merged agent neither holds nor waits.
  expect(toResourceView(rec, [agent('a', 'done'), agent('b', 'done')], null, 1000).queue).toEqual([])
})

test('an agent is found by its name or a distinctive part of it', async () => {
  const ids = ['billing-export-1a2b', 'billing-import-3c4d', 'login-redirect-5e6f']
  expect(resolveAgent(ids, 'login-redirect-5e6f')).toEqual({ id: 'login-redirect-5e6f' })
  expect(resolveAgent(ids, 'Login')).toEqual({ id: 'login-redirect-5e6f' })
  expect(resolveAgent(ids, 'import')).toEqual({ id: 'billing-import-3c4d' })
  expect('error' in resolveAgent(ids, 'billing')).toBe(true)
  expect('error' in resolveAgent(ids, 'nope')).toBe(true)
  expect('error' in resolveAgent([], 'x')).toBe(true)
})

test('names and docker output are read defensively', async () => {
  expect(resourceName(undefined)).toBe('stack')
  expect(resourceName('Local Stack!')).toBe('local-stack')
  expect(parseInspect('/db sha256:aa\nerror: no such object: gone\n/api sha256:bb\n\n')).toEqual({ db: 'sha256:aa', api: 'sha256:bb' })
  expect(parseInspect('')).toEqual({})
  const view = toResourceView(applyOp(fresh(), { kind: 'grant', agent: 'a' }, 1), [agent('a')], null, 2)
  expect(describeResource(view)).toBe('stack: held by a; queue: nobody; no containers reported in scope')
})
