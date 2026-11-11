import { expect, test } from 'claude-code/testing'

import { agentId, parseIdentity, parsePrView } from '../hooks/core/git'
import { isAgentRecord, mend, newRecord } from '../hooks/core/model'
import { DONE_KEPT_MS, isStale } from '../hooks/core/store'

test('an agent is named after its worktree folder, file-safe', async () => {
  expect(agentId('/repo/.claude/worktrees/billing-export-1a2b3c')).toBe('billing-export-1a2b3c')
  expect(agentId('/repo/my task (2)/')).toBe('my-task-2')
  expect(agentId('/')).toBe('agent')
})

test('every worktree of a repository shares one state folder', async () => {
  const main = parseIdentity('/repo/.git\n/repo\n', 'main\n')
  const tree = parseIdentity('/repo/.git\n/repo/.claude/worktrees/task-a\n', '\n')
  expect(main?.stateDir).toBe('/repo/.git/agent-stage-cc')
  expect(tree?.stateDir).toBe(main?.stateDir)
  expect(tree?.id).toBe('task-a')
  expect(tree?.branch).toBe(null)
  expect(parseIdentity('', '')).toBe(undefined)
})

test('a file that is not an agent record is not read as one', async () => {
  const rec = newRecord({ id: 'a', worktree: '/w', branch: null, stateDir: '/s' }, 's1', 1)
  expect(isAgentRecord(rec)).toBe(true)
  expect(isAgentRecord({ ...rec, state: 'dancing' })).toBe(false)
  expect(isAgentRecord({ ...rec, v: 2 })).toBe(false)
  expect(isAgentRecord(null)).toBe(false)
})

test('a file is stale once its worktree is gone or its merge has faded', async () => {
  const rec = newRecord({ id: 'a', worktree: '/w', branch: null, stateDir: '/s' }, 's1', 1000)
  expect(isStale(rec, true, 9e9)).toBe(false)
  expect(isStale(rec, false, 1000)).toBe(true)
  const done = { ...rec, state: 'done' as const, since: 5000 }
  expect(isStale(done, true, 5000 + DONE_KEPT_MS - 1)).toBe(false)
  expect(isStale(done, true, 5000 + DONE_KEPT_MS + 1)).toBe(true)
})

test('what the forge says of a PR is read, and silence is not a verdict', async () => {
  expect(parsePrView(0, '{"state":"MERGED","url":"https://x/pull/1"}', '')).toEqual({ state: 'merged', url: 'https://x/pull/1' })
  expect(parsePrView(0, '{"state":"OPEN"}', '')).toEqual({ state: 'open' })
  expect(parsePrView(1, '', 'no pull requests found for branch "x"')).toEqual({ state: 'closed' })
  // gh missing, signed out or offline says nothing about the PR.
  expect(parsePrView(1, '', 'gh: command not found')).toBe(undefined)
  expect(parsePrView(0, 'not json', '')).toBe(undefined)
  expect(parsePrView(0, '{"state":"DRAFT"}', '')).toBe(undefined)
})

test('a record claiming a PR without an address is mended on reading', async () => {
  const rec = newRecord({ id: 'a', worktree: '/w', branch: null, stateDir: '/s' }, 's1', 1)
  const broken = { ...rec, state: 'pr' as const, pr: {} as { url: string } }
  expect(mend(broken).state).toBe('idle')
  expect(mend(broken).pr).toBe(undefined)
  const sound = { ...rec, state: 'pr' as const, pr: { url: 'https://x/pull/1' } }
  expect(mend(sound)).toBe(sound)
})
