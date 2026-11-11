import { expect, test } from 'claude-code/testing'

import { levelsOf, measure, parseDockerStats, parseSample, platformOf, PROBES, settle } from '../hooks/core/usage'
import type { Machine } from '../hooks/core/usage'

const LINUX: Machine = { platform: 'linux', cores: 8, ramBytes: 32 * 1024 ** 3, clockTicks: 100, pageBytes: 4096 }
const MAC: Machine = { ...LINUX, platform: 'darwin' }

// pid, name, state, then the fields /proc/<pid>/stat carries; utime and stime
// are the 14th and 15th, rss in pages the 24th.
const stat = (pid: number, name: string, utime: number, stime: number, pages: number) =>
  `${pid} (${name}) S 1 1 1 0 -1 4194304 0 0 0 0 ${utime} ${stime} 0 0 20 0 1 0 100 1000000 ${pages} 18446744073709551615 0 0`

test('Linux: working directories and CPU time are read from /proc', async () => {
  const out = [
    '/proc/10/cwd /repo/wt/a',
    '/proc/11/cwd /repo/wt/a/src',
    '/proc/12/cwd /home/me',
    '---',
    stat(10, 'node', 300, 100, 1000),
    stat(11, 'my (odd) name', 50, 50, 500),
    stat(12, 'bash', 1, 1, 10),
    stat(13, 'other-user', 1, 1, 10),
  ].join('\n')
  const procs = parseSample(out, LINUX)
  expect(procs.map(p => p.pid)).toEqual([10, 11, 12])
  expect(procs[0]).toEqual({ pid: 10, cwd: '/repo/wt/a', cpuSeconds: 4, rssBytes: 4096000 })
  // A name with spaces and brackets does not shift the fields.
  expect(procs[1]?.cpuSeconds).toBe(1)
})

test('macOS: lsof and ps give the same facts', async () => {
  const out = ['p10', 'fcwd', 'n/repo/wt/a', 'p12', 'fcwd', 'n/Users/me', '---', '   10  12.5  20480', '   12   0,5   1024', '   99   1.0   10'].join('\n')
  const procs = parseSample(out, MAC)
  expect(procs).toEqual([
    { pid: 10, cwd: '/repo/wt/a', cpuPercent: 12.5, rssBytes: 20480 * 1024 },
    { pid: 12, cwd: '/Users/me', cpuPercent: 0.5, rssBytes: 1024 * 1024 },
  ])
})

test('each platform has a probe, an unknown one has none', async () => {
  expect(platformOf('Linux\n')).toBe('linux')
  expect(platformOf('Darwin\n')).toBe('darwin')
  expect(platformOf('FreeBSD')).toBe(undefined)
  expect(PROBES.linux.readMachine(['100', '4096', '16', '32000000'])).toEqual({ clockTicks: 100, pageBytes: 4096, cores: 16, ramBytes: 32000000 * 1024 })
  expect(PROBES.darwin.readMachine(['100', '16384', '10', '34359738368'])).toEqual({ clockTicks: 100, pageBytes: 16384, cores: 10, ramBytes: 34359738368 })
  // A machine that answers nothing still gets sane numbers.
  expect(PROBES.linux.readMachine([]).cores).toBe(1)
})

test('a worktree is charged for the processes working inside it', async () => {
  const trees = [{ id: 'main', path: '/repo' }, { id: 'a', path: '/repo/wt/a' }, { id: 'ab', path: '/repo/wt/ab' }]
  const procs = [
    { pid: 1, cwd: '/repo', cpuSeconds: 10, rssBytes: 100 },
    { pid: 2, cwd: '/repo/wt/a', cpuSeconds: 10, rssBytes: 200 },
    { pid: 3, cwd: '/repo/wt/a/deep/er', cpuSeconds: 10, rssBytes: 300 },
    { pid: 4, cwd: '/repo/wt/ab', cpuSeconds: 10, rssBytes: 400 },
    { pid: 5, cwd: '/elsewhere', cpuSeconds: 10, rssBytes: 999 },
  ]
  const first = measure(procs, trees, null, 0)
  // The nested worktree is not counted for the main checkout, nor `ab` for `a`.
  expect(first.usage).toEqual({ main: { cpu: 0, ramBytes: 100 }, a: { cpu: 0, ramBytes: 500 }, ab: { cpu: 0, ramBytes: 400 } })
  // Two seconds later process 2 has used one more second: half a core.
  const later = procs.map(p => (p.pid === 2 ? { ...p, cpuSeconds: 11 } : p))
  const second = measure(later, trees, first.cpuSeconds, 2000)
  expect(second.usage.a?.cpu).toBe(50)
  expect(second.usage.main?.cpu).toBe(0)
})

test('macOS rates are taken as given, a new process has no rate yet', async () => {
  const trees = [{ id: 'a', path: '/w/a' }]
  expect(measure([{ pid: 1, cwd: '/w/a', cpuPercent: 30, rssBytes: 1 }], trees, null, 0).usage.a?.cpu).toBe(30)
  expect(measure([{ pid: 9, cwd: '/w/a', cpuSeconds: 500, rssBytes: 1 }], trees, { 1: 2 }, 1000).usage.a?.cpu).toBe(0)
})

test('docker stats is read in any unit it prints', async () => {
  const out = 'api 12.50% 512MiB / 15.61GiB\ndb 0.00% 1.5GiB / 15.61GiB\nweb 3,2% 900kB / 2GB\ngarbage line\n'
  const usage = parseDockerStats(out)
  expect(usage.api).toEqual({ cpu: 12.5, ramBytes: 512 * 1024 ** 2 })
  expect(usage.db?.ramBytes).toBe(1.5 * 1024 ** 3)
  expect(usage.web).toEqual({ cpu: 3.2, ramBytes: 900000 })
  expect(Object.keys(usage).length).toBe(3)
})

test('the scene gets usage in coarse steps, the machine as the measure', async () => {
  const GB = 1024 ** 3
  const levels = levelsOf({
    agents: {
      quiet: { cpu: 2, ramBytes: 0.1 * GB },
      busy: { cpu: 30, ramBytes: 1 * GB },
      hard: { cpu: 120, ramBytes: 2 * GB },
      heavy: { cpu: 400, ramBytes: 5 * GB },
    },
    containers: { db: { cpu: 1, ramBytes: GB }, api: { cpu: 60, ramBytes: GB }, web: { cpu: 250, ramBytes: GB } },
    machine: { cores: 8, ramBytes: 32 * GB },
  })
  expect(levels.agents).toEqual({
    quiet: { cpu: 0, ram: 0 },
    busy: { cpu: 1, ram: 2 },
    hard: { cpu: 2, ram: 3 },
    heavy: { cpu: 3, ram: 4 },
  })
  expect(levels.containers).toEqual({ db: 0, api: 2, web: 3 })
  // 863% of one core over 8 cores is 108% of the machine: shown as full.
  expect(levels.cpuPercent).toBe(100)
  expect(levels.ramGb).toBe(11)
  expect(levels.machineGb).toBe(32)
})

test('jitter below what is shown does not make a new report', async () => {
  const report = settle({
    agents: { a: { cpu: 160.4, ramBytes: 2 * 1024 ** 3 } },
    containers: {},
    machine: { cores: 8, ramBytes: 32 * 1024 ** 3 },
  })
  const again = settle({ ...report, agents: { a: { cpu: 160.2, ramBytes: 2 * 1024 ** 3 + 5 } } })
  expect(JSON.stringify(again)).toBe(JSON.stringify(report))
})
