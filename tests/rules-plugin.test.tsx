import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

// A machine whose files are only the ones a test puts there; `git` answers as in a repository or outside one.
function machine(on: On, git: { top: string } | null) {
  const files = new Map<string, string>()
  const toasts: string[] = []
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
  on('fs.exists', (_, e) => ({ value: files.has(e.path) }))
  on('process.run', (_, e) => {
    const [bin, ...args] = e.argv
    const ok = (stdout: string) => ({ value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
    if (bin === 'git' && git === null) return { value: { exitCode: 128, stdout: '', stderr: 'not a git repository', isStdoutTruncated: false, isStderrTruncated: false } }
    if (bin === 'git' && args[0] === 'rev-parse') return ok(`${git?.top}/.git\n${git?.top}\n`)
    if (bin === 'git' && args[0] === 'branch') return ok('main\n')

    return ok('')
  })
  on('ui.panes', () => ({ value: [] }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.toast', (_, e) => {
    toasts.push(e.text)

    return { value: undefined }
  })
  on('session.usage', () => ({ value: { startedAt: 0, context: {} as never, rateLimits: [] } }))
  on('session.id', () => ({ value: 'sess-1' }))
  on('command.register', () => ({ value: { command: 'stage' } }))
  on('tool.register', () => ({ value: { tool: 'mcp__agent-stage-cc__resource' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('prompt.compose', () => ({ sections: [{ id: 'core', text: 'You are Claude.', scope: 'shared' as const }] }))

  return { files, toasts }
}

const compose = async ($: { prompt: { compose: (e: never) => Promise<{ sections: { id: string; text: string }[] }> } }) =>
  (await $.prompt.compose({ model: 'm', promptModel: 'm', surfaces: [], tools: [], outputStyle: null, traits: [] } as never)).sections

test('a repository with an AGENTS.md: the agent reads it first, and is told so in every thread', async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  mock.env(on, { HOME: '/home/me' })
  const { files, toasts } = machine(on, { top: '/repo' })
  on('session.cwd', () => ({ value: '/repo' }))
  files.set('/repo/AGENTS.md', '# Rules\n')
  files.set('/repo/CLAUDE.md', '# Claude\n')

  await $.session.start({ cwd: '/repo', surface: 'desktop', isInteractive: true })
  const rules = (await compose($ as never)).find(s => s.id === 'agent-stage-cc:rules')?.text ?? ''
  expect(rules).toContain('Its rules come first')
  // CLAUDE.md does not import it, so Claude Code would not read it: the agent is told to.
  expect(rules).toContain('read AGENTS.md now')
  files.set('/repo/CLAUDE.md', '@AGENTS.md\n\n# Claude\n')
  expect((await compose($ as never)).find(s => s.id === 'agent-stage-cc:rules')?.text).not.toContain('read AGENTS.md now')
  expect(toasts).toEqual([])
})

test('a folder outside any repository with no rules: init is suggested, once to the person, and its modes still work', async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  mock.env(on, { HOME: '/home/me' })
  const { files, toasts } = machine(on, null)
  on('session.cwd', () => ({ value: '/notes' }))
  // The folder's own settings are read though it is no repository: it starts in plan.
  files.set('/notes/.agent-stage-cc.json', '{"mode":"plan"}')

  await $.session.start({ cwd: '/notes', surface: 'desktop', isInteractive: true })
  const sections = await compose($ as never)
  expect(sections.find(s => s.id === 'agent-stage-cc:rules')?.text).toContain('`/stage agent init`')
  expect(sections.some(s => s.id === 'agent-stage-cc:mode' && s.text.includes('working mode `plan`'))).toBe(true)
  expect(toasts.filter(t => t.includes('/stage agent init'))).toHaveLength(1)
  // A reload of the mod tells the person nothing twice.
  await $.session.start({ cwd: '/notes', surface: 'desktop', isInteractive: true })
  expect(toasts.filter(t => t.includes('/stage agent init'))).toHaveLength(1)

  // Init writes AGENTS.md: the next thread is pointed at it, and nothing is suggested any more.
  files.set('/notes/AGENTS.md', '# Rules\n')
  const after = (await compose($ as never)).find(s => s.id === 'agent-stage-cc:rules')?.text ?? ''
  expect(after).toContain('# Project rules')
  expect(after).not.toContain('/stage agent init')
})

test('with init on, or the person saying no in their config, nothing is suggested', async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  mock.env(on, { HOME: '/home/me' })
  const { files, toasts } = machine(on, { top: '/repo' })
  on('session.cwd', () => ({ value: '/repo' }))
  files.set('/repo/.agent-stage-cc.json', '{"mode":"init"}')
  await $.session.start({ cwd: '/repo', surface: 'desktop', isInteractive: true })
  expect((await compose($ as never)).some(s => s.id === 'agent-stage-cc:rules')).toBe(false)
  expect(toasts.some(t => t.includes('No AGENTS.md'))).toBe(false)

  files.delete('/repo/.agent-stage-cc.json')
  // The person's config is read when a session starts.
  files.set('/home/me/.config/agent-stage-cc/config.json', '{"projectRules":false}')
  await $.command.run({ command: 'stage', args: 'agent off' } as never)
  await $.session.start({ cwd: '/repo', surface: 'desktop', isInteractive: true })
  expect((await compose($ as never)).some(s => s.id === 'agent-stage-cc:rules')).toBe(false)
  expect(toasts.some(t => t.includes('No AGENTS.md'))).toBe(false)
})
