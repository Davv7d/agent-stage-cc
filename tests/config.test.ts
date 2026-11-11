import { expect, test } from 'claude-code/testing'

import { DEFAULTS, GUIDE, readConfig, readProjectConfig } from '../hooks/core/config'
import { classify, DEFAULT_PATTERNS } from '../hooks/core/derive'

test('with no file, or a broken one, the defaults stand', async () => {
  expect(readConfig('')).toEqual(DEFAULTS)
  expect(readConfig('{ not json')).toEqual(DEFAULTS)
  expect(readConfig('[]')).toEqual(DEFAULTS)
  expect(readConfig('{"band":"yes","refreshSeconds":"soon","notify":7}')).toEqual(DEFAULTS)
})

test('a person turns things off and tunes the timing', async () => {
  const config = readConfig(JSON.stringify({
    band: false,
    notify: { question: true, failed: false, pr: true },
    refreshSeconds: 5,
    asleepAfterMinutes: 10,
  }))
  expect(config).toEqual({
    band: false,
    guide: true,
    notify: { question: true, failed: false, released: true, pr: true },
    refreshMs: 5000,
    asleepAfterMs: 600_000,
  })
  // Values that would hammer the machine or never fire are pulled into range.
  expect(readConfig('{"refreshSeconds":0.01}').refreshMs).toBe(1000)
  expect(readConfig('{"refreshSeconds":9999}').refreshMs).toBe(60_000)
})

test('a project names its own test commands and coordinating tools', async () => {
  const project = readProjectConfig(JSON.stringify({
    testCommands: ['\\./run-checks\\.sh\\b', '(unclosed'],
    coordinatorTools: ['^delegate_task$'],
  }))
  // The pattern that does not compile is dropped; the other still counts.
  expect(project.test?.length).toBe(1)
  const patterns = { test: project.test ?? DEFAULT_PATTERNS.test, coordinate: project.coordinate ?? DEFAULT_PATTERNS.coordinate }
  expect(classify('Bash', { command: './run-checks.sh --fast' }, patterns).kind).toBe('test')
  expect(classify('Bash', { command: 'pytest' }, patterns).kind).toBe('coding')
  expect(classify('delegate_task', {}, patterns).kind).toBe('coordinate')
  // A project that says nothing keeps the built-in patterns.
  expect(readProjectConfig('{}')).toEqual({})
  expect(readProjectConfig('nope')).toEqual({})
})

test('the guide teaches the tool and sets no policy', async () => {
  expect(DEFAULTS.guide).toBe(true)
  expect(readConfig('{"guide":false}').guide).toBe(false)
  for (const action of ['grant', 'queue', 'order', 'release', 'scope', 'status']) {
    expect(GUIDE).toContain(`\`${action}\``)
  }
  expect(GUIDE).toContain('mcp__agent-stage-cc__resource')
  expect(GUIDE).toContain('never report your own state')
  expect(GUIDE).toContain('It only records and shows')
})
