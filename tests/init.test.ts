import { expect, test } from 'claude-code/testing'

import { INIT } from '../hooks/core/init'
import { BUILT_IN, describeModes, mergeModes, modeBrief, startingMode, toMode } from '../hooks/core/modes'
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
    '`extraKnownMarketplaces`', '`enabledPlugins`',
  ]) expect(text).toContain(part)
  // A project's default mode needs the mod on each machine: the project names it, each person installs it.
  expect(text).toContain('the Agent Stage (`agent-stage-cc`) among them')
  expect(text).toContain('does not install them')
  // Instructions ask and settings enforce: the person is told which is which.
  expect(text).toContain('only asks the model')
  expect(text).toContain('enforced by Claude Code')
  expect(text).toContain('Never overwrite an existing file without showing the change')
  expect(text).toContain('Put no secrets in any file')
  // Every way of working a project may start in is offered, and the tools it may need.
  for (const name of ['plan', 'full', 'coordinate', 'research']) expect(text).toContain(`\`${name}\``)
  for (const tool of ['Claude in Chrome', "desktop app's built-in browser", 'MCP servers', 'Docker', 'shared resource']) expect(text).toContain(tool)
})

test("a session starts in the person's mode, in none once they ended it, or else in the project's default", async () => {
  const own = toMode('review', '# Review\n\nRead the diff.', 'project')
  if (own === undefined) throw new Error('a mode did not read')
  const modes = mergeModes(BUILT_IN, [own])
  const start = (kept: string | null | undefined, projectDefault: string | undefined, isKeptDefault = false) => {
    const found = startingMode(modes, kept, projectDefault, isKeptDefault)

    return found === null ? null : `${found.mode.name}${found.isProjectDefault ? ' (default)' : ''}`
  }
  // Nothing turned on or off in the session: the project's default, its own modes too.
  expect(start(undefined, 'plan')).toBe('plan (default)')
  expect(start(undefined, 'review')).toBe('review (default)')
  // The person's pick wins over it, the same mode included.
  expect(start('full', 'plan')).toBe('full')
  expect(start('plan', 'plan')).toBe('plan')
  // Kept over a reload, the default is still the default.
  expect(start('plan', 'plan', true)).toBe('plan (default)')
  // Turned off, it stays off until the session ends.
  expect(start(null, 'plan')).toBe(null)
  // A name that is no mode turns nothing on.
  expect(start(undefined, 'sprint')).toBe(null)
  expect(start(undefined, undefined)).toBe(null)
  // A mode the person kept and that is gone since leaves the default to stand.
  expect(start('audit', 'plan')).toBe('plan (default)')
  expect(start('audit', undefined)).toBe(null)
})

test("/stage agent names the project's default, and says why a name that is no mode is not on", async () => {
  const modes = mergeModes(BUILT_IN)
  expect(describeModes(modes, 'plan', 'plan')).toContain("On now: plan. The project's default: plan. Start one with /stage agent <name>")
  expect(describeModes(modes, undefined, 'sprint')).toContain(
    'None is on. The project\'s default "sprint" is not a mode on offer, so it was not turned on. Start one with',
  )
  expect(describeModes(modes, undefined)).not.toContain('default')
})

test("the agent is told when its mode is the project's default, and how it ends", async () => {
  const plan = builtIn('plan')
  const brief = modeBrief(plan, true)
  expect(brief).toContain('This project starts every session in the working mode `plan`')
  expect(brief).toContain('`/stage agent off`')
  expect(brief).not.toContain('The person turned on')
  expect(brief.endsWith(plan.text)).toBe(true)
  expect(modeBrief(plan)).toContain('The person turned on the working mode `plan` for this session.')
})
