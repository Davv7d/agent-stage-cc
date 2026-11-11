import { expect, test } from 'claude-code/testing'

import type { AgentRecord, AgentState, Limit, ResourceView, Snapshot, UsageReport } from '../types'
import { bandItems, noticesBetween, statusText, toBrief } from '../hooks/core/brief'
import { DEFAULTS } from '../hooks/core/config'
import { toSnapshot } from '../hooks/core/model'
import { parseShared, SHARED_FOR_MS, shouldMeasure } from '../hooks/core/usage'
import { WORDS } from '../hooks/scene/labels'

const agent = (id: string, state: AgentState, more: Partial<AgentRecord> = {}): AgentRecord => ({
  v: 1, id, worktree: `/w/${id}`, branch: null, sessionId: 's', isLive: true, role: 'agent',
  state, since: 0, lastAction: '', lastActionAt: 0, promptAt: 0, updatedAt: 0, ...more,
})
const stack = (more: Partial<ResourceView> = {}): ResourceView => ({
  v: 1, name: 'stack', holder: null, heldSince: 0, releasedAt: 0, queue: [], members: [], baseline: {},
  updatedAt: 0, swapped: [], phase: 'free', isUrgent: false, isStale: false, ...more,
})
const shot = (records: AgentRecord[], resources: ResourceView[] = []): Snapshot =>
  toSnapshot(records, 0, { asleepAfterMs: 1e12 }, resources)
const GB = 1024 ** 3
const USAGE: UsageReport = {
  // The machine runs more than the agents: the band shows the machine.
  system: { cpuPercent: 31.4, ramBytes: 38.2 * GB },
  agents: { a: { cpu: 120, ramBytes: 2 * GB }, b: { cpu: 40, ramBytes: 1.5 * GB } },
  containers: { api: { cpu: 80, ramBytes: 3.6 * GB } },
  machine: { cores: 16, ramBytes: 59.3 * GB },
}
const LIMITS: Limit[] = [
  { kind: 'five_hour', percentUsed: 36.4, resetsAt: '2026-11-11T16:40:00Z' },
  { kind: 'seven_day', percentUsed: 81 },
]
const EN = WORDS.en

test('the band is bare figures in a fixed order, each named on hover', async () => {
  const brief = toBrief(shot([agent('a', 'coding'), agent('b', 'coding')]), USAGE, LIMITS)
  // Limits show what is left, not what is used.
  expect(bandItems(brief, EN)).toEqual([
    // The stage's own share first, in a quieter shade, then the whole machine.
    { key: 'own-cpu', text: '15%', tone: 'ownCpu', hint: 'CPU agents' },
    { key: 'cpu', text: '31%', tone: 'cpu', hint: 'CPU system' },
    { key: 'own-ram', text: '7.1', tone: 'ownRam', hint: 'RAM agents GB' },
    { key: 'ram', text: '38.2/59', tone: 'ram', hint: 'RAM system GB' },
    { key: 'limit-five_hour', text: '64%', tone: 'short', hint: '5h' },
    { key: 'limit-seven_day', text: '19%', tone: 'low', hint: 'week' },
  ])
  // A status line has no hover, so there every figure carries its name.
  expect(statusText(brief, EN)).toBe('CPU 31% (agents 15%) · RAM 38.2/59 GB (agents 7.1) · 5h 64% · week 19%')
})

test('what runs out changes color, whatever it is', async () => {
  const limits = [{ kind: 'five_hour', percentUsed: 93 }, { kind: 'seven_day', percentUsed: 50 }, { kind: 'spend_limit', percentUsed: 140 }]
  const items = bandItems(toBrief(shot([]), null, limits), WORDS.pl)
  expect(items.map(i => `${i.text}|${i.tone}`)).toEqual(['7%|out', '50%|long', '0%|out'])
  expect(items.map(i => i.hint)).toEqual(['5h', 'week', 'spend_limit'])
  const hot = { system: { cpuPercent: 94, ramBytes: 50 * GB }, agents: {}, containers: {}, machine: { cores: 16, ramBytes: 59.3 * GB } }
  // Only the machine's totals warn; the stage's share keeps its shade.
  expect(bandItems(toBrief(shot([]), hot, []), EN).map(i => i.tone)).toEqual(['ownCpu', 'low', 'ownRam', 'low'])
  // Counted two ways, the share may come out above the whole: it is never shown so.
  const odd = { ...hot, system: { cpuPercent: 10, ramBytes: 4 * GB }, agents: { a: { cpu: 400, ramBytes: 6 * GB } } }
  expect(toBrief(shot([]), odd, []).usage?.own).toEqual({ cpuPercent: 10, ramGb: 4 })
})

test('questions and failed tests appear only when there are some', async () => {
  expect(bandItems(toBrief(shot([agent('a', 'coding')]), null, []), EN)).toEqual([])
  expect(statusText(toBrief(shot([agent('a', 'coding')]), null, []), EN)).toBe(undefined)
  const busy = toBrief(shot([agent('a', 'question'), agent('b', 'failed'), agent('c', 'question')], [stack({ holder: 'b', phase: 'held' })]), null, [])
  expect(bandItems(busy, EN)).toEqual([
    { key: 'questions', text: '?2', tone: 'ask', hint: 'questions' },
    { key: 'failed', text: '!1', tone: 'bad', hint: 'failed tests' },
  ])
  expect(statusText(busy, EN)).toBe('questions 2 · failed tests 1')
})

test('one session measures and the others read what it left', async () => {
  const mine = { at: 1000, by: 'me', report: USAGE }
  // Nobody has measured: a session that watches starts.
  expect(shouldMeasure(undefined, 'me', true, 1000)).toBe(true)
  // The one measuring goes on; another reads while the figures are fresh.
  expect(shouldMeasure(mine, 'me', true, 5000)).toBe(true)
  expect(shouldMeasure(mine, 'other', true, 5000)).toBe(false)
  // The measuring session went away: another takes over.
  expect(shouldMeasure(mine, 'other', true, 1000 + SHARED_FOR_MS + 1)).toBe(true)
  // A session that shows nothing never pays for the figures.
  expect(shouldMeasure(undefined, 'me', false, 1000)).toBe(false)
  expect(parseShared(JSON.stringify(mine))).toEqual(mine)
  expect(parseShared('{"at":1')).toBe(undefined)
  expect(parseShared('{"at":1,"by":"x","report":{}}')).toBe(undefined)
  // Figures left by a version that did not read the machine's own totals.
  const { system: _, ...old } = USAGE
  expect(parseShared(JSON.stringify({ ...mine, report: old }))).toBe(undefined)
})

test('a question, failed tests and a release are noticed once, as they happen', async () => {
  const lead = agent('lead', 'idle', { role: 'coordinator' })
  const before = shot([lead, agent('a', 'coding'), agent('b', 'testing')], [stack({ holder: 'b', phase: 'held' })])
  const after = shot([lead, agent('a', 'question'), agent('b', 'failed')], [stack()])
  expect(noticesBetween(before, after, DEFAULTS.notify)).toEqual([
    { kind: 'question', agent: 'a', isUrgent: false },
    { kind: 'failed', agent: 'b' },
    { kind: 'released', resource: 'stack', by: 'b' },
  ])
  // Nothing new happened: nothing is said again.
  expect(noticesBetween(after, after, DEFAULTS.notify)).toEqual([])
})

test('a question from the holder with others waiting is urgent', async () => {
  const held = [stack({ holder: 'a', phase: 'held', queue: ['b'] })]
  const notices = noticesBetween(
    shot([agent('a', 'testing'), agent('b', 'coding')], held),
    shot([agent('a', 'question'), agent('b', 'coding')], held),
    DEFAULTS.notify,
  )
  expect(notices).toEqual([{ kind: 'question', agent: 'a', isUrgent: true }])
  expect(WORDS.pl.notice.urgent('a')).toBe('a ma pytanie i blokuje kolejkę')
})

test('only the events a person asked for are noticed', async () => {
  const before = shot([agent('a', 'coding'), agent('b', 'coding')])
  const after = shot([agent('a', 'question'), agent('b', 'pr', { pr: { url: 'https://x/pull/1' } })])
  expect(noticesBetween(before, after, { ...DEFAULTS.notify, question: false })).toEqual([])
  expect(noticesBetween(before, after, { ...DEFAULTS.notify, pr: true }).map(n => n.kind)).toEqual(['question', 'pr'])
  // An agent first seen with a PR already open did not just open it.
  expect(noticesBetween(shot([]), after, { ...DEFAULTS.notify, question: false, pr: true })).toEqual([])
})
