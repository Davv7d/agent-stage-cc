import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

// A file system and a git in memory, standing for the machine beneath the mod.
function machine(on: On, top: string) {
  const files = new Map<string, string>()
  const gone = new Set<string>()
  on('fs.write', (_, e) => {
    files.set(e.path, e.text)

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
  on('fs.exists', (_, e) => ({ value: !gone.has(e.path) }))
  on('process.run', (_, e) => {
    const [bin, ...args] = e.argv
    let stdout = ''
    if (bin === 'git' && args[0] === 'rev-parse') stdout = `/repo/.git\n${top}\n`
    if (bin === 'git' && args[0] === 'branch') stdout = 'feat/x\n'
    if (bin === 'mv') {
      const [from, to] = args.slice(-2) as [string, string]
      files.set(to, files.get(from) ?? '')
      files.delete(from)
    }
    if (bin === 'rm') files.delete(args[args.length - 1] ?? '')

    return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('ui.panes', () => ({ value: [] }))
  on('ui.status', () => ({ value: undefined }))
  on('session.usage', () => ({
    value: {
      startedAt: 0,
      context: {} as never,
      rateLimits: [{ kind: 'five_hour', percentUsed: 36 }, { kind: 'seven_day', percentUsed: 81 }],
    },
  }))
  on('session.cwd', () => ({ value: top }))
  on('session.id', () => ({ value: 'sess-1' }))
  on('command.register', () => ({ value: { command: 'stage' } }))
  on('tool.register', () => ({ value: { tool: 'mcp__agent-stage-cc__resource' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_, e) => ({ text: e.answer }))

  return { files, gone }
}

const FILE = '/repo/.git/agent-stage-cc/agents/task-a.json'
const TOP = '/repo/.claude/worktrees/task-a'

test('an agent file follows what the session does, written whole', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const { files } = machine(on, TOP)
  let isError = false
  on('tool.call', () => ({ result: {}, text: 'out', ...(isError ? { isError: true } : {}) }))
  const state = () => JSON.parse(files.get(FILE) ?? '{}')

  await $.session.start({ cwd: TOP, surface: 'desktop', isInteractive: true })
  expect(state().id).toBe('task-a')
  expect(state().state).toBe('idle')
  expect(state().branch).toBe('feat/x')

  await $.turn.start({ text: 'do it', turnId: 't1' })
  expect(state().state).toBe('research')

  await clock.advance(5000)
  await $.tool.call({ tool: 'Edit', file_path: '/x/app.ts', old_string: 'a', new_string: 'b' })
  expect(state().state).toBe('coding')
  expect(state().lastAction).toBe('Edit app.ts')

  isError = true
  await clock.advance(5000)
  await $.tool.call({ tool: 'Bash', command: 'npm test' })
  expect(state().state).toBe('failed')

  // Nothing half-written is left beside the file.
  expect([...files.keys()].filter(p => p.endsWith('.tmp'))).toEqual([])
})

test('a turn ending on a question shows in the pane on every surface', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  machine(on, TOP)
  on('tool.call', () => ({ result: {} }))
  on('ui.open', () => ({ value: { isPlaced: true } }))

  await $.session.start({ cwd: TOP, surface: 'desktop', isInteractive: true })
  await $.turn.start({ text: 'do it', turnId: 't1' })
  await $.turn.complete({ answer: 'Which database should I use?', reason: 'answer', durationMs: 1, isAborted: false, turnId: 't1' })
  await clock.advance(3000)

  const PANE = {
    plugin: 'agent-stage-cc',
    component: 'Pane',
    requestId: 'agent-stage',
    props: { title: 'Agent Stage', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 20 }, view: {} },
  } as const

  // The terminal has no vector element: it gets the same facts as a list.
  const list = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await list.find({ type: 'Text', text: /task-a/ }))?.text).toMatch(/task-a · question for you/)
  await list.unmount()

  for (const surface of ['desktop', 'vscode', 'mobile'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    const svg = await ui.find({ type: 'Svg' })
    expect(String(svg?.props.source)).toContain('task-a')
    expect(String(svg?.props.source)).toContain('question for you')
    // Switching the labels off redraws the scene without them.
    await ui.press({ key: 'labels' })
    expect(String((await ui.find({ type: 'Svg' }))?.props.source)).not.toContain('class="t st" text-anchor="middle">question for you')
    await ui.press({ key: 'labels' })
    await ui.unmount()
  }
})

test('an agent whose worktree is gone is cleaned up', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const { files, gone } = machine(on, TOP)
  const other = '/repo/.git/agent-stage-cc/agents/old-task.json'
  files.set(other, JSON.stringify({
    v: 1, id: 'old-task', worktree: '/repo/.claude/worktrees/old-task', branch: null, sessionId: 's0',
    isLive: false, role: 'agent', state: 'idle', since: 1, lastAction: '', lastActionAt: 1, promptAt: 0, updatedAt: 1,
  }))
  gone.add('/repo/.claude/worktrees/old-task')

  await $.session.start({ cwd: TOP, surface: 'desktop', isInteractive: true })
  await clock.advance(3000)

  expect(files.has(other)).toBe(false)
  expect(files.has(FILE)).toBe(true)
})

test('outside a git repository the mod stays out of the way', async ($, on) => {
  mock.clock(on, { now: 1 })
  const writes: string[] = []
  on('fs.write', (_, e) => {
    writes.push(e.path)

    return { value: undefined }
  })
  on('process.run', () => ({ value: { exitCode: 128, stdout: '', stderr: 'not a git repository', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('session.cwd', () => ({ value: '/tmp/x' }))
  on('session.id', () => ({ value: 's' }))
  on('command.register', () => ({ value: { command: 'stage' } }))
  on('tool.register', () => ({ value: { tool: 'mcp__agent-stage-cc__resource' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('tool.call', () => ({ result: { ok: true } }))

  await $.session.start({ cwd: '/tmp/x', surface: 'terminal', isInteractive: true })
  const ran = await $.tool.call({ tool: 'Bash', command: 'ls' })

  expect(ran.result).toEqual({ ok: true })
  expect(writes).toEqual([])
})

test('the coordinator grants the stack and the lock file follows', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const { files } = machine(on, TOP)
  on('tool.call', () => ({ result: {} }))
  const lock = () => JSON.parse(files.get('/repo/.git/agent-stage-cc/resources/stack.json') ?? '{}')
  const ask = async (input: Record<string, unknown>) =>
    String((await $.tool.call({ tool: 'mcp__agent-stage-cc__resource', ...input })).result)

  await $.session.start({ cwd: TOP, surface: 'desktop', isInteractive: true })
  expect(await ask({ action: 'status' })).toContain('no shared resource is in use')

  expect(await ask({ action: 'queue' })).toContain('queue: task-a')
  expect(lock().queue).toEqual(['task-a'])

  // A distinctive part of the name is enough; left out, it means this session.
  expect(await ask({ action: 'grant', agent: 'task' })).toContain('held by task-a')
  expect(lock().holder).toBe('task-a')
  expect(lock().queue).toEqual([])

  expect(await ask({ action: 'grant', agent: 'nobody-here' })).toContain('no agent matches')
  expect(lock().holder).toBe('task-a')

  await clock.advance(1000)
  expect(await ask({ action: 'release' })).toContain('stack: free')
  expect(lock().holder).toBe(null)
  expect(await ask({ action: 'dance' })).toContain('action must be one of')
})

test('the lead session announces a question and shows the band', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const { files } = machine(on, '/repo')
  on('tool.call', () => ({ result: {} }))
  const said: string[] = []
  on('ui.notify', (_, e) => {
    said.push(e.text)

    return { value: { isSent: false, reason: 'no-surface' } }
  })
  on('ui.toast', (_, e) => {
    said.push(`toast: ${e.text}`)

    return { value: undefined }
  })
  const other = (state: string) =>
    files.set('/repo/.git/agent-stage-cc/agents/task-a.json', JSON.stringify({
      v: 1, id: 'task-a', worktree: '/repo/wt/task-a', branch: null, sessionId: 's2', isLive: true, role: 'agent',
      state, since: 1, lastAction: '', lastActionAt: 1, promptAt: 0, updatedAt: 1_000_000,
    }))

  await $.session.start({ cwd: '/repo', surface: 'desktop', isInteractive: true })
  // Handing out work is what makes this session the coordinator.
  await $.tool.call({ tool: 'mcp__ccd_session__start_session', title: 'Task A' })
  other('coding')
  await clock.advance(3000)
  expect(said).toEqual([])

  other('question')
  await clock.advance(3000)
  // Where no native notification can be sent, a toast says it.
  expect(said).toEqual(['task-a has a question for you', 'toast: task-a has a question for you'])
  await clock.advance(6000)
  expect(said.length).toBe(2)

  const BAND = {
    plugin: 'agent-stage-cc', component: 'AbovePrompt', requestId: 'band',
    props: { hasSurvey: false, isCollapsed: false, isWorking: false, maxRows: 3, bodyColumns: 80, scroll: { offset: 0, bodyRows: 3 }, view: {} },
  } as const
  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    const band = await $.ui.mount({ ...BAND, surface })
    // Bare figures: the question count, then what is left of each limit.
    expect((await band.find({ type: 'Text', text: /^\?/ }))?.text).toBe('?1')
    expect((await band.find({ type: 'Text', text: /^64%/ }))?.text).toBe('64%')
    expect((await band.find({ type: 'Text', text: /^19%/ }))?.text).toBe('19%')
    // The name of a figure is in the tree, shown while the pointer is on it.
    expect((await band.find({ type: 'Text', text: /questions/ }))?.text).toBe(' questions')
    await band.unmount()
  }
  // The person can put the band away.
  const band = await $.ui.mount({ ...BAND, surface: 'desktop' })
  await band.press({ key: 'stage-hide' })
  expect(await band.find({ type: 'Text', text: /^64%/ })).toBe(undefined)
  await band.unmount()
})

test('each session is told how to keep the record, unless the person says no', async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  const { files } = machine(on, TOP)
  mock.env(on, { HOME: '/home/me' })
  on('prompt.compose', () => ({ sections: [{ id: 'core', text: 'You are Claude.', scope: 'shared' as const }] }))
  const compose = async () =>
    (await $.prompt.compose({ model: 'm', promptModel: 'm', surfaces: [], tools: [], outputStyle: null, traits: [] } as never)).sections

  await $.session.start({ cwd: TOP, surface: 'desktop', isInteractive: true })
  const sections = await compose()
  expect(sections.map(s => s.id)).toEqual(['core', 'agent-stage-cc:guide'])
  expect(sections[1]?.scope).toBe('session')

  files.set('/home/me/.config/agent-stage-cc/config.json', '{"guide":false}')
  await $.session.start({ cwd: TOP, surface: 'desktop', isInteractive: true })
  expect((await compose()).map(s => s.id)).toEqual(['core'])
})
