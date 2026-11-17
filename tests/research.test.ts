import { expect, test } from 'claude-code/testing'

import type { AgentRecord, Research } from '../types'
import { classify } from '../hooks/core/derive'
import type { Action } from '../hooks/core/derive'
import { mend, newRecord } from '../hooks/core/model'
import { apply } from '../hooks/core/reduce'
import type { StageEvent } from '../hooks/core/reduce'
import {
  BUCKET_MS,
  domainOf,
  emptyResearch,
  HISTORY_MS,
  inFlightOf,
  isSearchCall,
  MAX_PROBES,
  MAX_SOURCES,
  sampled,
  SERIES,
  seriesOf,
  sourcesOf,
} from '../hooks/core/research'

const WHO = { id: 'topic-scan', worktree: '/repo/wt/topic-scan', branch: 'b', stateDir: '/repo/.git/agent-stage-cc' }
const fresh = () => newRecord(WHO, 's1', 1000)
const run = (rec: AgentRecord, events: StageEvent[]) => events.reduce(apply, rec)
const READ: Action = { kind: 'research', label: 'WebSearch x' }
const search = (at: number, loop?: string): StageEvent => ({ kind: 'tool-start', at, action: READ, isSearch: true, ...(loop === undefined ? {} : { loop }) })
const found = (at: number, loop?: string, domains: string[] = []): StageEvent => ({
  kind: 'tool-end', at, action: READ, isError: false, isSearch: true,
  ...(loop === undefined ? {} : { loop }), found: domains.map(domain => ({ domain, isRead: false })),
})
const spawn = (at: number, id: string, label: string, isBackground = false): StageEvent => ({ kind: 'probe-start', at, id, label, isBackground })
const research = (rec: AgentRecord): Research => {
  if (rec.research === undefined) throw new Error('no research kept')

  return rec.research
}

test('a spawn starts the research, and a probe counts its own calls', async () => {
  let rec = run(fresh(), [spawn(2000, 'a1', '  How   long do cells last?  ')])
  expect(research(rec).probes).toEqual([{ id: 'a1', label: 'How long do cells last?', status: 'running', inFlight: 0, calls: 0, startedAt: 2000 }])
  rec = run(rec, [search(2100, 'a1'), search(2200, 'a1'), search(2300)])
  expect(research(rec).probes[0]?.inFlight).toBe(2)
  expect(research(rec).inFlight).toBe(1)
  expect(inFlightOf(research(rec))).toBe(3)
  expect(research(rec).calls).toBe(3)
  rec = run(rec, [found(2400, 'a1', ['cells.example'])])
  expect(research(rec).probes[0]?.inFlight).toBe(1)
  expect(research(rec).probes[0]?.calls).toBe(2)
  // Its own turn's end finishes it, and nothing of it is left running.
  rec = run(rec, [{ kind: 'probe-end', at: 3000, id: 'a1', reason: 'answer' }])
  expect(research(rec).probes[0]).toEqual({ id: 'a1', label: 'How long do cells last?', status: 'done', inFlight: 0, calls: 2, startedAt: 2000, endedAt: 3000 })
  // Stopped and failed are told apart.
  const stopped = run(rec, [spawn(3100, 'a2', 'x'), { kind: 'probe-end', at: 3200, id: 'a2', reason: 'aborted' }])
  expect(research(stopped).probes[1]?.status).toBe('stopped')
  const failed = run(rec, [spawn(3100, 'a2', 'x'), { kind: 'probe-end', at: 3200, id: 'a2', reason: 'error' }])
  expect(research(failed).probes[1]?.status).toBe('failed')
})

test('without a spawn or a pane that watches, a session keeps no research', async () => {
  const rec = run(fresh(), [search(2000), found(2100, undefined, ['x.example']), { kind: 'probe-start', at: 2200, id: 'a1' }, { kind: 'probe-end', at: 2300, id: 'a1', reason: 'answer' }])
  expect(rec.research).toBe(undefined)
  // Watched, it is kept from then on.
  const watched = run(fresh(), [{ kind: 'research-watch', at: 2000 }, search(2100)])
  expect(research(watched).inFlight).toBe(1)
  expect(research(watched).since).toBe(2000)
})

test('counts never stick: turn end, abort and session end clear what runs', async () => {
  const busy = run(fresh(), [spawn(2000, 'fg', 'front'), spawn(2000, 'bg', 'back', true), search(2100), search(2100, 'fg'), search(2100, 'bg')])
  expect(inFlightOf(research(busy))).toBe(3)
  // The turn could not end before its foreground probe did; one in the background runs on.
  const ended = run(busy, [{ kind: 'turn-end', at: 3000, answer: 'Here is what I found.', reason: 'answer' }])
  expect(research(ended).inFlight).toBe(0)
  expect(research(ended).probes.map(p => [p.id, p.status, p.inFlight])).toEqual([['fg', 'done', 0], ['bg', 'running', 1]])
  const aborted = run(busy, [{ kind: 'turn-end', at: 3000, answer: '', reason: 'aborted' }])
  expect(research(aborted).probes[0]?.status).toBe('stopped')
  const gone = run(busy, [{ kind: 'session-end', at: 4000 }])
  expect(inFlightOf(research(gone))).toBe(0)
  expect(research(gone).probes.every(p => p.status === 'stopped')).toBe(true)
  // An end that comes after the clearing does not count below nothing.
  expect(research(run(ended, [found(3100)])).inFlight).toBe(0)
})

test('only a subagent sent out is a probe: the engine\'s own forks are not', async () => {
  // A loop nobody spawned (a compaction, a memory fork) searches and ends: nothing of it counts.
  let rec = run(fresh(), [
    { kind: 'research-watch', at: 1000 },
    { kind: 'probe-start', at: 1500, id: 'fork' },
    search(2000, 'fork'),
    found(2100, 'fork', ['x.example']),
    { kind: 'probe-end', at: 2200, id: 'fork', reason: 'answer' },
  ])
  expect(research(rec)).toEqual(emptyResearch(1000))
  // A spawned probe, finished and woken again for another turn, runs again under its first name.
  rec = run(rec, [spawn(3000, 'p1', 'First name'), search(3100, 'p1'), found(3200, 'p1'), { kind: 'probe-end', at: 3300, id: 'p1', reason: 'answer' }])
  rec = run(rec, [{ kind: 'probe-start', at: 4000, id: 'p1' }, { kind: 'probe-start', at: 4100, id: 'p1', label: 'Another' }])
  expect(research(rec).probes).toEqual([{ id: 'p1', label: 'First name', status: 'running', inFlight: 0, calls: 1, startedAt: 3000 }])
})

test('a record keeps a bounded number of probes, the running ones first', async () => {
  let rec = fresh()
  for (let i = 0; i < MAX_PROBES + 6; i++) {
    rec = apply(rec, spawn(1000 + i, `p${i}`, `probe ${i}`))
    if (i % 2 === 0) rec = apply(rec, { kind: 'probe-end', at: 1000 + i, id: `p${i}`, reason: 'answer' })
  }
  const kept = research(rec).probes
  expect(kept.length).toBe(MAX_PROBES)
  // Every probe still running is there; the finished ones that went were the oldest.
  expect(kept.filter(p => p.status === 'running').length).toBe((MAX_PROBES + 6) / 2)
  expect(kept.some(p => p.id === 'p0')).toBe(false)
  expect(kept.some(p => p.id === 'p28')).toBe(true)
})

test('domains are read from fetched pages and search results, each once', async () => {
  expect(domainOf('https://www.Example.org/a?b=1')).toBe('example.org')
  expect(domainOf('http://user@docs.example.net:8080/x')).toBe('docs.example.net')
  expect(['ftp://x.example/a', 'not a url', 'https://localhost/x', ''].map(domainOf)).toEqual([undefined, undefined, undefined, undefined])
  expect(sourcesOf('WebFetch', { url: 'https://a.example/page' }, { url: 'https://www.a.example/page', code: 200 }, '')).toEqual([{ domain: 'a.example', isRead: true }])
  const results = { query: 'q', results: [{ tool_use_id: 't', content: [{ title: 'A', url: 'https://a.example/1' }, { title: 'B', url: 'https://b.example/2' }, { title: 'A2', url: 'https://a.example/3' }] }, 'a note'] }
  expect(sourcesOf('WebSearch', { query: 'q' }, results, '')).toEqual([{ domain: 'a.example', isRead: false }, { domain: 'b.example', isRead: false }])
  // Without the tool's record, the links in what the model read.
  expect(sourcesOf('WebSearch', { query: 'q' }, undefined, 'Links: [{"url":"https://c.example/x"}] and https://d.example.')).toEqual([
    { domain: 'c.example', isRead: false },
    { domain: 'd.example', isRead: false },
  ])
  expect(sourcesOf('mcp__docs__search_pages', {}, undefined, 'see https://e.example/p')).toEqual([{ domain: 'e.example', isRead: false }])
  expect(sourcesOf('Read', { file_path: '/x' }, undefined, 'https://f.example')).toEqual([])
})

test('sources pile up by domain, read ones marked, and the shelf has an end', async () => {
  let rec = run(fresh(), [{ kind: 'research-watch', at: 1000 }, search(2000), found(2100, undefined, ['a.example', 'b.example'])])
  rec = apply(rec, { kind: 'tool-end', at: 2200, action: READ, isError: false, isSearch: true, found: [{ domain: 'a.example', isRead: true }] })
  expect(research(rec).sources).toEqual([{ domain: 'a.example', hits: 2, isRead: true }, { domain: 'b.example', hits: 1 }])
  const many = Array.from({ length: MAX_SOURCES + 5 }, (_, i) => `s${i}.example`)
  rec = apply(rec, found(2300, undefined, many))
  expect(research(rec).sources.length).toBe(MAX_SOURCES)
  expect(research(rec).sourcesCapped).toBe(true)
})

test('what ran at once is kept in steps of ten seconds for ten minutes, with its peak', async () => {
  const at = (s: number) => 1_000_000_000 + s * 1000
  let rec = run(fresh(), [{ kind: 'research-watch', at: at(0) }, search(at(1)), search(at(2)), search(at(3)), found(at(4)), found(at(5))])
  // One step holds the most that ran in it.
  expect(research(rec).history).toEqual([{ at: Math.floor(at(1) / BUCKET_MS) * BUCKET_MS, n: 3 }])
  expect(research(rec).peak).toBe(3)
  expect(research(rec).peakAt).toBe(at(3))
  // One call runs on for half a minute: the steps it ran through are written in once it ends.
  rec = apply(rec, found(at(37)))
  const steps = research(rec).history.map(s => s.n)
  expect(steps).toEqual([3, 1, 1, 1])
  // Ten minutes on, the old steps are gone.
  rec = run(rec, [search(at(700)), found(at(701))])
  expect(research(rec).history.every(s => s.at > at(700) - HISTORY_MS)).toBe(true)
  expect(research(rec).peak).toBe(3)
  // A level that held a long time writes no more than the window.
  expect(sampled([{ at: 0, n: 2 }], 2, 0, HISTORY_MS - 1).length).toBe(SERIES)
  expect(sampled([{ at: 0, n: 2 }], 2, 0, 3_600_000).length).toBe(1)
})

test('the scene gets the last ten minutes, ending now, with the peak marked', async () => {
  const r: Research = { ...emptyResearch(0), inFlight: 2, history: [{ at: 100_000, n: 4 }, { at: 110_000, n: 2 }], peak: 4, peakAt: 101_000 }
  const { series, peakIndex } = seriesOf(r, 135_000)
  expect(series.length).toBe(SERIES)
  // The steps since the last change hold the level that runs now.
  expect(series.slice(-5)).toEqual([0, 4, 2, 2, 2])
  expect(series[peakIndex]).toBe(4)
  expect(peakIndex).toBe(SERIES - 4)
  // A peak older than the window is not marked.
  expect(seriesOf(r, 135_000 + HISTORY_MS).peakIndex).toBe(-1)
})

test('a new order after a finished plan starts its research anew, unless some still runs', async () => {
  const done = run(fresh(), [
    spawn(2000, 'a1', 'one'),
    { kind: 'probe-end', at: 2500, id: 'a1', reason: 'answer' },
    { kind: 'plan-call', at: 2600, tool: 'TodoWrite', input: { todos: [{ content: 'Report', status: 'completed' }] } },
    { kind: 'turn-end', at: 3000, answer: 'Done.', reason: 'answer' },
  ])
  const next = apply(done, { kind: 'turn-start', at: 4000 })
  expect(research(next).probes).toEqual([])
  expect(research(next).since).toBe(4000)
  // A probe still at work in the background keeps the research going.
  const busy = run(done, [spawn(3500, 'bg', 'back', true), { kind: 'turn-start', at: 4000 }])
  expect(research(busy).probes.length).toBe(2)
  // An answer in the middle of a plan carries on with the same research.
  const midway = run(fresh(), [spawn(2000, 'a1', 'one'), { kind: 'plan-call', at: 2100, tool: 'TodoWrite', input: { todos: [{ content: 'Question', status: 'in_progress' }] } }, { kind: 'turn-start', at: 4000 }])
  expect(research(midway).probes.length).toBe(1)
  // Another session in the worktree does not inherit it.
  expect(apply(done, { kind: 'session-start', at: 5000, sessionId: 's2' }).research).toBe(undefined)
})

test('searching and reading is what counts, not looking up a tool', async () => {
  const counts = (tool: string, input: Record<string, unknown> = {}) => isSearchCall(tool, classify(tool, input))
  expect(['Read', 'Grep', 'Glob', 'WebSearch', 'WebFetch'].map(t => counts(t))).toEqual([true, true, true, true, true])
  expect(counts('Bash', { command: 'rg -n retry src | head' })).toBe(true)
  expect(counts('Bash', { command: 'npm install' })).toBe(false)
  expect(counts('Edit', { file_path: '/x' })).toBe(false)
  expect(counts('ToolSearch', { query: 'select:WebFetch' })).toBe(false)
  expect(counts('mcp__docs__search_pages')).toBe(true)
  expect(counts('mcp__web__fetch')).toBe(true)
  expect(counts('mcp__chat__send_message')).toBe(false)
})

test('research a stored record cannot be read by is left out, a sound one kept as it is', async () => {
  const sound = run(fresh(), [spawn(2000, 'a1', 'one')])
  expect(mend(sound)).toBe(sound)
  const broken = { ...sound, research: { probes: 'many' } } as unknown as AgentRecord
  expect(mend(broken).research).toBe(undefined)
  expect(mend(broken).id).toBe('topic-scan')
})
