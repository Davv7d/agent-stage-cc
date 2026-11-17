import { expect, test } from 'claude-code/testing'

import { BUILT_IN, describeModes, mergeModes, modeBrief, modeName, toMode } from '../hooks/core/modes'
import { planAfter } from '../hooks/core/plan'

test('a mode is a named file of rules, titled by its first heading', async () => {
  expect(modeName('plan.md')).toBe('plan')
  expect(modeName('code-review.md')).toBe('code-review')
  // Only plain names: nothing that could reach outside the folder or hide.
  expect(['../x.md', 'Plan.md', '.hidden.md', 'notes.txt', 'a b.md', '.md'].map(modeName)).toEqual(Array(6).fill(undefined))
  const mode = toMode('review', '\n# Review before merge\n\nRead the diff first.\n', 'yours')
  expect(mode).toEqual({ name: 'review', title: 'Review before merge', text: '# Review before merge\n\nRead the diff first.', from: 'yours', view: 'plan' })
  expect(toMode('bare', 'Just do it.', 'project')?.title).toBe('bare')
  expect(toMode('empty', '  \n ', 'yours')).toBe(undefined)
  // Rules are an instruction, not a book.
  expect(toMode('long', 'x'.repeat(50_000), 'yours')?.text.length).toBe(12_000)
})

test('a mode file may say which scene it is watched on and that its session coordinates', async () => {
  const mode = toMode('lead', '---\nview: team\nrole: coordinator\nowner: nobody\n---\n# Lead\n\nHand the work out.', 'project')
  expect(mode?.view).toBe('team')
  expect(mode?.role).toBe('coordinator')
  // The settings are for the stage: the agent reads the rules alone.
  expect(mode?.text).toBe('# Lead\n\nHand the work out.')
  expect(mode?.title).toBe('Lead')
  // Anything else leaves the mode as any other: watched on its agent's plan.
  const plain = toMode('odd', '---\nview: sideways\nrole: king\n---\nRules.', 'yours')
  expect(plain?.view).toBe('plan')
  expect(plain?.role).toBe(undefined)
  // A file's line endings are its editor's business.
  const windows = toMode('lead', '---\r\nview: team\r\nrole: coordinator\r\n---\r\n# Lead\r\n\r\nHand the work out.\r\n', 'project')
  expect([windows?.view, windows?.role, windows?.text]).toEqual(['team', 'coordinator', '# Lead\n\nHand the work out.'])
  // A rule set that merely uses a line of dashes is not cut.
  expect(toMode('dashes', 'First.\n\n---\n\nSecond.', 'yours')?.text).toBe('First.\n\n---\n\nSecond.')
})

test('coordinating is a mode too: tasks in, work out, the shared resource kept in order', async () => {
  const mode = BUILT_IN.find(m => m.name === 'coordinate')
  if (mode === undefined) throw new Error('no coordinate mode')
  expect(mode.view).toBe('team')
  expect(mode.role).toBe('coordinator')
  expect(mode.text.startsWith('# Coordinate other agents')).toBe(true)
  for (const word of ['Take the task in', 'Split and hand out', 'Watch over', 'Keep the shared resource in order', 'Bring the results in']) {
    expect(mode.text).toContain(`**${word}.**`)
  }
  // The record of the resource is kept with the stage's own tool, by its actions.
  for (const action of ['grant', 'queue', 'order', 'release', 'scope']) expect(mode.text).toContain(`\`${action}\``)
  // Who goes first stays the person's and the project's to say.
  expect(mode.text).toContain("decided by the person's instructions and the project's rules")
})

test('researching is a mode too: the question first, probes in parallel, every claim sourced', async () => {
  const mode = BUILT_IN.find(m => m.name === 'research')
  if (mode === undefined) throw new Error('no research mode')
  expect(mode.view).toBe('research')
  expect(mode.role).toBe(undefined)
  expect(mode.text.startsWith('# Research a topic')).toBe(true)
  const order = ['Question', 'Research plan', 'Gathering', 'Verification', 'Report'].map(p => mode.text.indexOf(`**${p}.**`))
  expect(order.every((at, i) => at > 0 && (i === 0 || at > (order[i - 1] ?? 0)))).toBe(true)
  // Where the report goes is asked, and a file is made only with the person's leave.
  expect(mode.text).toContain('`research/<slug>.md`')
  expect(mode.text).toContain('only if the person agrees')
  expect(mode.text).toContain('at most five at a time')
  expect(mode.text).toContain('at least two independent sources')
  expect(mode.text).toContain('task list')
  // Its settings are for the stage alone; a file of one's own may name the scene too.
  expect(mode.text).not.toContain('view: research')
  expect(toMode('dig', '---\nview: research\n---\n# Dig\n\nDig deep.', 'yours')?.view).toBe('research')
})

test('the built-in modes: plan first, the whole task in one run, and coordinating', async () => {
  expect(BUILT_IN.map(m => m.name)).toEqual(['plan', 'full', 'research', 'coordinate', 'init'])
  expect(BUILT_IN.slice(0, 2).map(m => m.view)).toEqual(['plan', 'plan'])
  const plan = BUILT_IN[0]?.text ?? ''
  // The phases a person asked for, in order, and the stop before the work.
  const order = ['Context', 'Requirements', 'Proposal', 'Implementation', 'Check'].map(p => plan.indexOf(`**${p}.**`))
  expect(order.every((at, i) => at > 0 && (i === 0 || at > (order[i - 1] ?? 0)))).toBe(true)
  expect(plan).toContain('AGENTS.md, CLAUDE.md')
  expect(plan).toContain('Then stop and wait')
  expect(plan).toContain('task list')
  expect(BUILT_IN[1]?.text).toContain('without stopping for approval')
  // Nothing of any one project, or of any one kind of project, is in them.
  for (const mode of BUILT_IN) expect(/npm|pytest|yarn|make |docker/i.test(mode.text)).toBe(false)
})

test("a project's mode wins over a person's, and a person's over a built-in one", async () => {
  const mine = toMode('plan', '# My plan\n\nMine.', 'yours')
  const theirs = toMode('plan', '# Team plan\n\nTheirs.', 'project')
  const extra = toMode('audit', 'Audit.', 'yours')
  if (mine === undefined || theirs === undefined || extra === undefined) throw new Error('a mode did not read')
  expect(mergeModes(BUILT_IN, [mine, extra]).map(m => `${m.name}:${m.from}`)).toEqual(['audit:yours', 'coordinate:built-in', 'full:built-in', 'init:built-in', 'plan:yours', 'research:built-in'])
  expect(mergeModes(BUILT_IN, [mine], [theirs]).find(m => m.name === 'plan')?.title).toBe('Team plan')
  expect(describeModes(mergeModes(BUILT_IN), undefined)).toBe(
    'Working modes: coordinate (built-in), full (built-in), init (built-in), plan (built-in), research (built-in). None is on. Start one with /stage agent <name>, end it with /stage agent off.',
  )
  expect(describeModes(mergeModes(BUILT_IN), 'plan')).toContain('On now: plan.')
})

test('the agent is told the mode by name, with its rules whole', async () => {
  const mode = BUILT_IN[0]
  if (mode === undefined) throw new Error('no built-in mode')
  const brief = modeBrief(mode)
  expect(brief).toContain('working mode `plan`')
  expect(brief).toContain('until the person says otherwise')
  expect(brief.endsWith(mode.text)).toBe(true)
})

test('a plan that goes on over turns is not checked off because one turn ended', async () => {
  const phases = [
    { content: 'Context', status: 'completed' },
    { content: 'Requirements', status: 'in_progress' },
    { content: 'Proposal', status: 'pending' },
  ]
  const plan = planAfter(undefined, 'mcp__host__update_plan', { items: phases }, undefined, 1)
  const closed = planAfter(plan, 'mcp__host__wrap_up', { recap: 'I have questions.' }, undefined, 2)
  expect(closed.map(s => s.status)).toEqual(['done', 'active', 'pending'])
})
