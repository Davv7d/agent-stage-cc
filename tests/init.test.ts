import { expect, test } from 'claude-code/testing'

import { INIT } from '../hooks/core/init'
import { BUILT_IN, describeModes, mergeModes, modeBrief, startingMode, toMode } from '../hooks/core/modes'
import type { Mode } from '../hooks/core/modes'

const builtIn = (name: string): Mode => {
  const mode = BUILT_IN.find(m => m.name === name)
  if (mode === undefined) throw new Error(`no ${name} mode`)

  return mode
}

test('init asks what the project is for, gathers, sums up and waits, then writes', async () => {
  const mode = builtIn('init')
  expect(mode.title).toBe('Set the project up for any agent')
  expect(mode.view).toBe('plan')
  expect(mode.role).toBe(undefined)
  // Whole: nothing of it is cut to fit.
  expect(INIT.length).toBeLessThan(12_000)
  expect(mode.text).toBe(INIT.trim())
  const phases = ['Purpose', 'Look around', 'Where it lives', 'Requirements', 'Working rules', 'Summary', 'Write', 'Check']
  const at = phases.map(p => mode.text.indexOf(`**${p}.**`))
  expect(at.every((x, i) => x > 0 && (i === 0 || x > (at[i - 1] ?? 0)))).toBe(true)
  expect(mode.text).toContain('Keep the phases as your task list')
  // What the project is for comes before any detailed question, and shapes them.
  expect(mode.text).toContain('Before any detailed question, ask in a sentence or two what the project is for')
  for (const kind of ['software', 'writing', 'research']) expect(mode.text).toContain(`For ${kind}:`)
  // It looks before it asks, sums up and stops before it writes.
  expect(mode.text).toContain('Change nothing.')
  expect(mode.text).toContain('ask only about the gaps')
  expect(mode.text).toContain('Ask whether that is everything')
  expect(mode.text).toContain('Then stop and wait. Write nothing in the same turn as the summary.')
  // Where the person does not know, options and a recommendation; the person decides.
  expect(mode.text).toContain('propose two or three options')
  expect(mode.text).toContain('the person decides')
})

test('init writes plain files any assistant reads, into the repository unless the person says no', async () => {
  const text = builtIn('init').text
  // Plain files any agent reads: AGENTS.md first, one file per skill in skills/.
  for (const part of ['`AGENTS.md`', '`skills/`', 'one Markdown file per skill', '`testing_rules.md`', '`zasady_testowania.md`', 'without accented letters', '`scripts/`']) {
    expect(text).toContain(part)
  }
  for (const assistant of ['Claude Code', 'ChatGPT', 'Codex']) expect(text).toContain(assistant)
  expect(text).toContain('its rules come first')
  // Nothing for one assistant alone unless asked; a CLAUDE.md is only ever pointed at AGENTS.md.
  expect(text).toContain('Write nothing that only one assistant understands, unless the person asks for it.')
  expect(text).not.toContain('.claude/skills')
  for (const part of ['`@AGENTS.md`', 'do not create one', '`.claude/settings.json`', '`.mcp.json`', '`.agent-stage-cc.json`', 'come only on request']) {
    expect(text).toContain(part)
  }
  // A repository: found or cloned, the files go in it unless the person says no; committing and pushing are asked.
  expect(text).toContain('clone it there and work in that copy')
  expect(text).toContain('unless the person says they must stay out of it')
  expect(text).toContain('`.git/info/exclude`')
  expect(text).toContain('made only once the person agrees to it, and pushed only once they agree to that too')
  expect(text).toContain('Never overwrite an existing file without showing the change')
  expect(text).toContain('Put no secrets in any file')
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

test("every mode tells the agent that the project's own rules come first", async () => {
  for (const mode of BUILT_IN) expect(modeBrief(mode)).toContain("The project's own rules, in its AGENTS.md where it has one, come first")
  expect(builtIn('research').text).toContain('its AGENTS.md and the skills it points to')
})
