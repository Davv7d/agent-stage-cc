import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const TOP = '/repo/.claude/worktrees/topic-scan'
const FILE = '/repo/.git/agent-stage-cc/agents/topic-scan.json'

// A file system and a git in memory, as in the plugin's other tests; every write is counted.
function machine(on: On) {
  const files = new Map<string, string>()
  const writes: string[] = []
  on('fs.write', (_, e) => {
    files.set(e.path, e.text)
    writes.push(e.path)

    return { value: undefined }
  })
  on('fs.read', (_, e) => {
    const text = files.get(e.path)
    if (text === undefined) throw new Error('ENOENT')

    return { value: text }
  })
  on('fs.list', (_, e) => ({
    value: [...files.keys()]
      .filter(p => p.startsWith(`${e.path}/`))
      .map(p => ({ name: p.slice(e.path.length + 1), kind: 'file' as const, size: 1, mtimeMs: 0, isLink: false })),
  }))
  on('fs.exists', () => ({ value: true }))
  on('process.run', (_, e) => {
    const [bin, ...args] = e.argv
    let stdout = ''
    if (bin === 'git' && args[0] === 'rev-parse') stdout = `/repo/.git\n${TOP}\n`
    if (bin === 'git' && args[0] === 'branch') stdout = 'research/x\n'
    if (bin === 'mv') {
      const [from, to] = args.slice(-2) as [string, string]
      files.set(to, files.get(from) ?? '')
      files.delete(from)
    }

    return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('ui.panes', () => ({ value: [] }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.usage', () => ({ value: { startedAt: 0, context: {} as never, rateLimits: [] } }))
  on('session.cwd', () => ({ value: TOP }))
  on('session.id', () => ({ value: 'sess-1' }))
  on('command.register', () => ({ value: { command: 'stage' } }))
  on('tool.register', () => ({ value: { tool: 'mcp__agent-stage-cc__resource' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_, e) => ({ text: e.answer }))
  let spawned = 0
  on('agent.spawn', () => ({ model: 'm', agentId: `sub-${++spawned}` }))

  return { files, writes }
}

const PANE = {
  plugin: 'agent-stage-cc',
  component: 'Pane',
  requestId: 'agent-stage',
  props: { title: 'Agent Stage', isFocused: false, bodyColumns: 140, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
} as const
const SEARCH = { tool: 'WebSearch', query: 'home battery lifespan', mode: 'standard' } as const
const RESULTS = { query: 'q', results: [{ tool_use_id: 't', content: [{ title: 'A', url: 'https://www.cells.example/a' }, { title: 'B', url: 'https://grid.example/b' }] }], durationSeconds: 1 }

test('a spawn sends a probe out; its calls, its sources and its end reach the record', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  mock.env(on, { HOME: '/home/me' })
  const { files } = machine(on)
  on('tool.call', (_, e) => (e.tool === 'WebSearch' ? { result: RESULTS, text: 'found' } : { result: {} }))
  const research = () => JSON.parse(files.get(FILE) ?? '{}').research

  await $.session.start({ cwd: TOP, surface: 'desktop', isInteractive: true })
  // Before any spawn, and with no pane on the research, nothing of it is kept.
  await $.tool.call({ tool: 'Read', file_path: '/x/notes.md' })
  expect(research()).toBe(undefined)

  await $.turn.start({ text: 'research home batteries', turnId: 't1' })
  const started = await $.agent.spawn({ prompt: 'Find what field studies say.', description: 'Capacity loss in field studies' } as never)
  expect(started.agentId).toBe('sub-1')
  const [sent] = research().probes
  expect([sent.id, sent.label, sent.status, sent.inFlight, sent.calls, sent.startedAt]).toEqual(['sub-1', 'Capacity loss in field studies', 'running', 0, 0, 1_000_000])

  await $.tool.call({ ...SEARCH, agentId: 'sub-1' } as never)
  await clock.advance(1000)
  expect(research().probes[0].calls).toBe(1)
  expect(research().sources).toEqual([{ domain: 'cells.example', hits: 1 }, { domain: 'grid.example', hits: 1 }])
  // The probe's own turn ends: it is done, and the stage is told at once.
  await $.turn.complete({ answer: 'Findings: ...', reason: 'answer', durationMs: 1, isAborted: false, turnId: 't2', agentId: 'sub-1' } as never)
  expect(research().probes[0].status).toBe('done')
  expect(research().probes[0].endedAt).toBe(1_001_000)
})

test('many searches at once are written a few times, and the last count always lands', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  mock.env(on, { HOME: '/home/me' })
  const { files, writes } = machine(on)
  let open: () => void = () => undefined
  const gate = new Promise<void>(resolve => (open = resolve))
  on('tool.call', async (_, e) => {
    if (e.tool === 'WebSearch') await gate

    return e.tool === 'WebSearch' ? { result: RESULTS, text: 'found' } : { result: {} }
  })
  const research = () => JSON.parse(files.get(FILE) ?? '{}').research

  await $.session.start({ cwd: TOP, surface: 'desktop', isInteractive: true })
  await $.turn.start({ text: 'go', turnId: 't1' })
  await $.agent.spawn({ prompt: 'p', description: 'One' } as never)
  await $.agent.spawn({ prompt: 'p', description: 'Two' } as never)
  await clock.advance(5000)
  const before = writes.filter(p => p.startsWith(FILE)).length
  // Twelve searches start at once, in the session and in both probes, and end at once.
  const calls = Array.from({ length: 12 }, (_, i) => $.tool.call({ ...SEARCH, ...(i % 3 === 0 ? {} : { agentId: `sub-${i % 3}` }) } as never))
  await clock.advance(10)
  open()
  await Promise.all(calls)
  expect(writes.filter(p => p.startsWith(FILE)).length - before).toBeLessThan(4)
  // Once the second is up, what is written is what runs: nothing.
  await clock.advance(1000)
  expect(research().inFlight).toBe(0)
  expect(research().probes.map((p: { inFlight: number; calls: number }) => [p.inFlight, p.calls])).toEqual([[0, 4], [0, 4]])
  expect(research().calls).toBe(12)
  expect(research().peak).toBe(12)
  expect(writes.filter(p => p.startsWith(FILE)).length - before).toBeLessThan(6)
})

test('counts never stick: the end of the turn clears what the session ran', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  mock.env(on, { HOME: '/home/me' })
  const { files } = machine(on)
  let open: () => void = () => undefined
  const gate = new Promise<void>(resolve => (open = resolve))
  on('tool.call', async () => {
    await gate

    return { result: {} }
  })
  const research = () => JSON.parse(files.get(FILE) ?? '{}').research

  await $.session.start({ cwd: TOP, surface: 'desktop', isInteractive: true })
  await $.turn.start({ text: 'go', turnId: 't1' })
  await $.agent.spawn({ prompt: 'p', description: 'One' } as never)
  const hanging = $.tool.call({ tool: 'Read', file_path: '/x/x.md' })
  await clock.advance(1000)
  expect(research().inFlight).toBe(1)
  // The turn is broken off while the search hangs.
  await $.turn.complete({ answer: '', reason: 'aborted', durationMs: 1, isAborted: true, turnId: 't1' })
  expect(research().inFlight).toBe(0)
  open()
  await hanging
  expect(research().inFlight).toBe(0)
})

test('the research mode shows the research scene, on every surface', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  mock.env(on, { HOME: '/home/me' })
  machine(on)
  on('tool.call', (_, e) => (e.tool === 'WebSearch' ? { result: RESULTS, text: 'found' } : { result: {} }))

  await $.session.start({ cwd: TOP, surface: 'desktop', isInteractive: true })
  const told = await $.command.run({ command: 'stage', args: 'agent research' } as never)
  expect(told.text).toBe('Working mode "research" is on (Research a topic). Say what you want done.')
  expect(told.context?.[0]).toContain('**Gathering.**')
  await $.turn.start({ text: 'how long do home batteries last?', turnId: 't1' })
  await $.agent.spawn({ prompt: 'p', description: 'Cycle life by chemistry' } as never)
  await $.tool.call({ ...SEARCH, agentId: 'sub-1' } as never)
  await clock.advance(3000)

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const source = String((await ui.find({ type: 'Svg' }))?.props.source)
  expect(source).toContain('>in flight: 0 searches · 1 probe · 2 sources<')
  expect(source).toContain('Cycle life by')
  expect(source).toContain('cells.example')
  expect(String((await ui.find({ key: 'view' }))?.props.label)).toMatch(/View: research/)
  await ui.unmount()

  const list = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await list.find({ type: 'Text', text: /in flight/ }))?.text).toBe('in flight: 0 searches · 1 probe · 2 sources')
  expect((await list.find({ type: 'Text', text: /Cycle life/ }))?.text).toBe('▸ Cycle life by chemistry · 0 in flight · 1 call')
  await list.unmount()
})

test('/stage view research keeps the research from then on, and the demo shows one', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  mock.env(on, { HOME: '/home/me' })
  const { files } = machine(on)
  on('tool.call', () => ({ result: {} }))
  const research = () => JSON.parse(files.get(FILE) ?? '{}').research

  await $.session.start({ cwd: TOP, surface: 'desktop', isInteractive: true })
  const told = await $.command.run({ command: 'stage', args: 'view research' } as never)
  expect(told.text).toMatch(/View: research, showing the research of topic-scan\./)
  await $.tool.call({ tool: 'Read', file_path: '/x/retry.md' })
  await clock.advance(3000)
  expect(research().calls).toBe(1)

  expect((await $.command.run({ command: 'stage', args: 'demo research' } as never)).text).toMatch(/demo data/)
  await clock.advance(3000)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const source = String((await ui.find({ type: 'Svg' }))?.props.source)
  expect(source).toContain('home-batteries')
  expect(source).toContain('SOURCES')
  await ui.unmount()
})
