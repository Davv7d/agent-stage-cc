import { expect, test } from 'claude-code/testing'

import { INIT } from '../hooks/core/init'
import { BUILT_IN } from '../hooks/core/modes'
import type { Mode } from '../hooks/core/modes'

const builtIn = (name: string): Mode => {
  const mode = BUILT_IN.find(m => m.name === name)
  if (mode === undefined) throw new Error(`no ${name} mode`)

  return mode
}

test('init sets a project up in phases kept as the task list, watched on its plan', async () => {
  const mode = builtIn('init')
  expect(mode.title).toBe('Set the project up for agents')
  expect(mode.view).toBe('plan')
  expect(mode.role).toBe(undefined)
  // Whole: nothing of it is cut to fit.
  expect(INIT.length).toBeLessThan(12_000)
  expect(mode.text).toBe(INIT.trim())
  const phases = ['Look around', 'The project', 'Technologies', 'Working rules', 'Access and tools', 'Proposal', 'Write', 'Check']
  const at = phases.map(p => mode.text.indexOf(`**${p}.**`))
  expect(at.every((x, i) => x > 0 && (i === 0 || x > (at[i - 1] ?? 0)))).toBe(true)
  expect(mode.text).toContain('Keep the phases as your task list')
  // It looks before it asks, and stops before it writes.
  expect(mode.text).toContain('Change nothing.')
  expect(mode.text).toContain('ask only about the gaps')
  expect(mode.text).toContain('Then stop and wait. Write nothing in the same turn as the proposal.')
  // Where the person does not know, options and a recommendation; the person decides.
  expect(mode.text).toContain('propose two or three options')
  expect(mode.text).toContain('the person decides')
})

test('init writes each file where Claude Code reads it, and asks before it changes one', async () => {
  const text = builtIn('init').text
  for (const part of [
    '`AGENTS.md`', '`CLAUDE.md`', '`@AGENTS.md`', '`.claude/skills/<name>/SKILL.md`', '`name`', '`description`',
    '`.claude/settings.json`', '`allow`', '`deny`', '`additionalDirectories`', '`.claude/settings.local.json`',
    '`.mcp.json`', '`${VARIABLE}`', '`.agent-stage-cc.json`', '`"mode"`', '`"testCommands"`',
  ]) expect(text).toContain(part)
  // Instructions ask and settings enforce: the person is told which is which.
  expect(text).toContain('only asks the model')
  expect(text).toContain('enforced by Claude Code')
  expect(text).toContain('Never overwrite an existing file without showing the change')
  expect(text).toContain('Put no secrets in any file')
  // Every way of working a project may start in is offered, and the tools it may need.
  for (const name of ['plan', 'full', 'coordinate', 'research']) expect(text).toContain(`\`${name}\``)
  for (const tool of ['Claude in Chrome', "desktop app's built-in browser", 'MCP servers', 'Docker', 'shared resource']) expect(text).toContain(tool)
})
