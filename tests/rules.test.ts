import { expect, test } from 'claude-code/testing'

import { hasRules, rulesBrief } from '../hooks/core/rules'
import type { Rules } from '../hooks/core/rules'

const rules = (more: Partial<Rules> = {}): Rules => ({ hasAgents: false, hasClaude: false, isAgentsImported: false, ...more })

test("AGENTS.md comes first, and the agent reads it itself where Claude Code would not", async () => {
  const plain = rulesBrief(rules({ hasAgents: true }), false) ?? ''
  expect(plain).toContain('# Project rules')
  expect(plain).toContain('Its rules come first')
  expect(plain).toContain('`skills/`')
  expect(plain).not.toContain('does not load AGENTS.md')
  // A CLAUDE.md that does not bring AGENTS.md in hides it from Claude Code: the agent is told to read it.
  expect(rulesBrief(rules({ hasAgents: true, hasClaude: true }), false)).toContain('read AGENTS.md now, before anything else')
  expect(rulesBrief(rules({ hasAgents: true, hasClaude: true, isAgentsImported: true }), false)).not.toContain('does not load AGENTS.md')
})

test('where no rules are written down, the agent suggests init once; a CLAUDE.md alone needs nothing', async () => {
  const none = rulesBrief(rules(), false) ?? ''
  expect(none).toContain('# No project rules yet')
  expect(none).toContain('`/stage agent init`')
  expect(none).toContain('Suggest it once')
  expect(hasRules(rules())).toBe(false)
  // Init is on already: nothing to suggest.
  expect(rulesBrief(rules(), true)).toBe(undefined)
  // Claude Code reads a CLAUDE.md by itself.
  expect(rulesBrief(rules({ hasClaude: true }), false)).toBe(undefined)
  expect(hasRules(rules({ hasClaude: true }))).toBe(true)
})
