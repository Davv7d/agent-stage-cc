import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, ToolCallResult } from 'claude-code'

import type { AgentRecord, Limit, ResourceView, Snapshot, Stage, Usage, UsageReport, ViewMode, ViewToggles } from '../types'
import { bandItems, noticesBetween, statusText, toBrief } from './core/brief'
import type { Tone } from './core/brief'
import type { Notice } from './core/brief'
import { DEFAULTS, GLOBAL_CONFIG, GUIDE, PROJECT_CONFIG, readConfig, readProjectConfig, viewOf } from './core/config'
import type { Config } from './core/config'
import { demoPlanSnapshot, demoResearchSnapshot, demoSnapshot, demoUsage } from './core/demo'
import { describeModes, loadModes, MODE_ENDED, modeBrief, startingMode } from './core/modes'
import { findRules, hasRules, NO_RULES_NOTICE, rulesBrief } from './core/rules'
import type { Rules } from './core/rules'
import type { Mode } from './core/modes'
import { isPlanTool, isSessionList } from './core/plan'
import { classify, DEFAULT_PATTERNS } from './core/derive'
import type { Patterns } from './core/derive'
import { inspectImages } from './core/docker'
import { locate, prState } from './core/git'
import { EMPTY, newRecord, toSnapshot } from './core/model'
import type { Identity } from './core/model'
import { apply } from './core/reduce'
import type { StageEvent } from './core/reduce'
import { isSearchCall, sourcesOf } from './core/research'
import {
  applyOp,
  describeResource,
  emptyResource,
  resolveAgent,
  resourceName,
  toResourceView,
} from './core/resource'
import type { ResourceOp } from './core/resource'
import { load, loadAll, loadResources, prune, save, saveResource } from './core/store'
import {
  measure,
  parseShared,
  readMachine,
  sampleContainers,
  sample,
  settle,
  systemLoad,
  sharedFile,
  SHARED_FOR_MS,
  shouldMeasure,
} from './core/usage'
import type { Machine, Sys } from './core/usage'
import { appleLanguage, langFrom, namesLanguage, WORDS } from './scene/labels'
import type { Lang } from './scene/labels'
import { fitLayout, fitPlan, fitResearch } from './scene/layout'
import type { Layout } from './scene/layout'
import { neon } from './scene/neon'
import { renderPlan } from './scene/plan'
import { renderResearch, researchRows } from './scene/research'
import { ASK, BAD, WARN } from './scene/skin'
import { describeScene, MAX_SOURCE, nameOf, renderScene } from './scene/scene'
import { advance } from './scene/stage'

const PANE = 'agent-stage'
const TOOL = 'mcp__agent-stage-cc__resource'
/** Every this many polls the machine is asked which images the scope runs. */
const INSPECT_EVERY = 3
/** Every this many polls an agent with an open PR asks what became of it. */
const PR_CHECK_EVERY = 20
/** Every this many polls the processes are measured, and the containers. */
const USAGE_EVERY = 2
const CONTAINERS_EVERY = 6
/** Every this many polls the account's rate limits are read. */
const LIMITS_EVERY = 5
/** Every this many polls the config files are read again. */
const CONFIG_EVERY = 10
const ACTIONS = ['status', 'grant', 'release', 'queue', 'unqueue', 'order', 'scope'] as const
type ResourceAction = (typeof ACTIONS)[number]

const TOOL_DESCRIPTION = [
  'Records who holds a shared resource that only one agent should use at a time (by default the local `stack` of containers) and who waits for it, and shows it on the Agent Stage.',
  'It only records and shows: nothing is blocked, restored or enforced. Who gets the resource is decided by the person or the coordinator.',
  '`grant` gives the resource to an agent and `release` frees it; `queue`, `unqueue` and `order` manage the waiting line.',
  '`scope` is for the holder, before it changes anything: the containers it will touch, so swapped images can be told from the originals.',
  '`status` reads the current state of every agent and resource.',
  '`agent` is a worktree name or a distinctive part of one; left out, it means the calling session.',
].join(' ')

const TOOL_SCHEMA = {
  type: 'object',
  properties: {
    action: { type: 'string', enum: [...ACTIONS] },
    resource: { type: 'string', description: 'Name of the resource; `stack` when left out.' },
    agent: { type: 'string', description: 'For grant, queue and unqueue.' },
    agents: { type: 'array', items: { type: 'string' }, description: 'For order: the queue, first in line first.' },
    containers: { type: 'array', items: { type: 'string' }, description: 'For scope: container names.' },
  },
  required: ['action'],
  additionalProperties: false,
}

const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []
/** A change of the last action alone is written at most this often. */
const QUIET_WRITE_MS = 3000
/**
 * A change of the research alone (a search begun or ended) is written at
 * most this often, however many run at once; the last one is written once
 * the time is up.
 */
const RESEARCH_WRITE_MS = 1000

const snapshot = atom({ plugin: 'agent-stage-cc', key: 'snapshot' } as const, EMPTY, {
  shape: 'snapshot-2',
})

const stageNow = atom({ plugin: 'agent-stage-cc', key: 'stage' } as const, null, {
  shape: 'stage-5',
})
const ALL_ON: ViewToggles = { focus: false, labels: true, links: true }
const view = atom({ plugin: 'agent-stage-cc', key: 'view' } as const, ALL_ON)
const demo = atom({ plugin: 'agent-stage-cc', key: 'demo' } as const, false)
/** The scene a person picked; null leaves it to the config. */
const viewMode = atom({ plugin: 'agent-stage-cc', key: 'viewMode' } as const, null)
/** The working mode turned on for the session, by name: kept over a reload. */
const workMode = atom({ plugin: 'agent-stage-cc', key: 'workMode' } as const, null)
/** That mode is the project's default, on from the start, not one the person turned on. */
const isWorkModeDefault = atom({ plugin: 'agent-stage-cc', key: 'isWorkModeDefault' } as const, false)
const briefNow = atom({ plugin: 'agent-stage-cc', key: 'brief' } as const, null, { shape: 'brief-4' })
const bandHidden = atom({ plugin: 'agent-stage-cc', key: 'bandHidden' } as const, false)
/** The person was told the folder has no rules for agents: once a session. */
const isRulesNoted = atom({ plugin: 'agent-stage-cc', key: 'isRulesNoted' } as const, false)

/** The band's colors: one per figure, amber and red for what runs out. */
const TONES: Record<Tone, string> = {
  cpu: '#60a5fa', ram: '#5eead4', ownCpu: '#4b78b8', ownRam: '#3f9f95', short: '#a78bfa', long: '#c4b5fd', other: '#9aa5b8',
  low: WARN, out: BAD, ask: ASK, bad: BAD,
}

const VIEWS: Record<Lang, Record<ViewMode, string>> = {
  en: { auto: 'View: auto', team: 'View: team', plan: 'View: plan', research: 'View: research' },
  pl: { auto: 'Widok: auto', team: 'Widok: zespół', plan: 'Widok: plan', research: 'Widok: research' },
}
/** Said on the view switch when a plan is asked for and nobody keeps one. */
const NO_PLAN: Record<Lang, string> = { en: ' (no plan yet)', pl: ' (brak planu)' }
const NEXT_VIEW: Record<ViewMode, ViewMode> = { auto: 'team', team: 'plan', plan: 'research', research: 'auto' }

const TOGGLES: Record<Lang, Record<keyof ViewToggles, string>> = {
  en: { focus: 'Needs attention only', labels: 'State labels', links: 'Links' },
  pl: { focus: 'Tylko wymagające uwagi', labels: 'Opisy stanów', links: 'Połączenia' },
}

/** What this session knows of itself between events; lost on a reload. */
type Self = {
  who: Identity | undefined
  rec: AgentRecord | undefined
  written: string
  writtenAt: number
  /** The research as last written, and whether a write of a later one is due. */
  researchWritten: string
  /** The session's title as the app last gave it. */
  title: string | undefined
  isFlushDue: boolean
  /** A save is under way, and the record changed again meanwhile. */
  /** The save under way, if any; a change made meanwhile sets `isDirty`. */
  saving: Promise<void> | null
  isDirty: boolean
  isLocated: boolean
  /** What the views last got, so an unchanged poll redraws nothing. */
  shown: string
  stage: Stage | null
  polls: number
  isDemo: boolean
  /** Which invented data the demo shows. */
  demoKind: 'team' | 'plan' | 'research'
  /** The working mode the person turned on for this session, or the project's default. */
  mode: Mode | null
  /** The mode on is the project's default, not one the person turned on. */
  isModeDefault: boolean
  /** The default mode the project's `.agent-stage-cc.json` names, on offer or not. */
  projectMode: string | undefined
  /** The folder the session started in. */
  cwd: string
  /** The instruction files the project holds, once looked for. */
  rules: Rules | null
  lang: Lang
  /** The language the machine itself is set to; the config may name another. */
  systemLang: Lang
  utcOffsetMinutes: number
  config: Config
  patterns: Patterns
  /** The stage as last seen, to tell what happened since; and the brief shown. */
  last: Snapshot | null
  briefShown: string
  /** The machine as asked once; null where no probe knows the platform. */
  machine: Machine | null | undefined
  /** CPU time each process had at the last sample, and when that was. */
  cpuSeconds: Record<number, number> | null
  /** The machine's last reading, for the CPU rate of the next. */
  system: Sys | null
  sampledAt: number
  containers: Record<string, Usage>
  usage: UsageReport | null
  limits: Limit[]
  sessionId: string
  /** The last thing that went wrong in the background, for `status` to say. */
  trouble: string
  /** What the machine last said each container in scope runs; null: unknown. */
  images: Record<string, string> | null
  /** The pane's last measured size, kept for tuning the pixel estimate. */
  pane: string
  paneWritten: string
}

/** What a command prints, or nothing where the machine has no such command. */
async function printed($: EngineInterface, argv: readonly string[]): Promise<string> {
  try {
    const ran = await $.process.run([...argv], { timeoutMs: 5000 })

    return ran.exitCode === 0 ? ran.stdout.trim() : ''
  } catch {
    return ''
  }
}

/** The machine's language and clock offset, asked once: hooks have no locale. */
async function readLocale($: EngineInterface, self: Self): Promise<void> {
  try {
    const env = [
      await $.env.get('LC_ALL'),
      await $.env.get('LC_MESSAGES'),
      await $.env.get('LANG'),
      (await $.env.get('LANGUAGE'))?.split(':')[0],
    ]
    // An app started from a dock or a menu often has no locale in its
    // environment: then the system's own setting is asked, each in its way.
    const asked = env.some(namesLanguage) ? [] : [
      appleLanguage(await printed($, ['defaults', 'read', '-g', 'AppleLanguages'])),
      await printed($, ['powershell', '-NoProfile', '-Command', '(Get-UICulture).Name']),
    ]
    self.systemLang = langFrom([...env, ...asked])
    self.lang = self.config.language === 'auto' ? self.systemLang : self.config.language
    const zone = await $.process.run(['date', '+%z'], { timeoutMs: 5000 })
    const match = /^([+-])(\d\d)(\d\d)/.exec(zone.stdout.trim())
    if (match) self.utcOffsetMinutes = (match[1] === '-' ? -1 : 1) * (Number(match[2]) * 60 + Number(match[3]))
  } catch {
    // English and UTC stand when the machine does not say.
  }
}

// Who this session is: asked of git once, and again when the session moved.
async function locateSelf($: EngineInterface, self: Self, at: number): Promise<void> {
  const cwd = await $.session.cwd()
  self.who = await locate($, cwd)
  self.isLocated = true
  if (self.who === undefined) {
    self.rec = undefined

    return
  }
  const sessionId = await $.session.id()
  const stored = await load($, self.who.stateDir, self.who.id)
  // Only this session writes its record, and what it holds may be ahead of
  // the file: a write still under way, research written once a second. It is
  // read from the file only when this session holds none, or another session
  // took the worktree since.
  const isOwn = self.rec !== undefined && self.rec.id === self.who.id && self.rec.sessionId === (stored?.sessionId ?? self.rec.sessionId)
  const base = isOwn && self.rec !== undefined ? self.rec : (stored ?? newRecord(self.who, sessionId, at))
  self.rec = { ...base, worktree: self.who.worktree, branch: self.who.branch }
}

async function emit(
  $: EngineInterface,
  self: Self,
  make: (at: number) => StageEvent,
): Promise<void> {
  try {
    const at = await $.clock.now()
    if (!self.isLocated) await locateSelf($, self, at)
    if (self.rec === undefined || self.who === undefined) return
    const before = self.rec
    self.rec = apply(self.rec, make(at))
    const { updatedAt: _a, lastAction: _b, lastActionAt: _c, research, ...core } = self.rec
    const key = JSON.stringify(core)
    // The research alone changes with every search begun or ended: however
    // many run at once, it is written at most once a second.
    const isResearchWritten = JSON.stringify(research ?? null) === self.researchWritten
    if (key === self.written && at - self.writtenAt < (isResearchWritten ? QUIET_WRITE_MS : RESEARCH_WRITE_MS)) {
      if (!isResearchWritten) flushLater($, self)

      return
    }
    await store($, self, at)
    if (before.state !== self.rec.state || probesOut(before) !== probesOut(self.rec)) void refresh($, self)
  } catch {
    // The stage watches; it never gets in the way of the work.
  }
}

const probesOut = (rec: AgentRecord) => rec.research?.probes.filter(p => p.status === 'running').length ?? 0

/**
 * Writes the record as it is now. Calls that run at once end at once: a save
 * asked for while one is under way is not made beside it; the one under way
 * writes the latest record again when it is done.
 */
async function store($: EngineInterface, self: Self, at: number): Promise<void> {
  if (self.rec === undefined || self.who === undefined) return
  const { updatedAt: _a, lastAction: _b, lastActionAt: _c, research, ...core } = self.rec
  self.written = JSON.stringify(core)
  self.researchWritten = JSON.stringify(research ?? null)
  self.writtenAt = at
  // A save under way writes the latest record again before it settles: wait
  // for it, so that whoever reads the file next finds this record there.
  while (self.saving !== null) {
    self.isDirty = true
    await self.saving
    if (!self.isDirty) return
  }
  self.saving = saveLatest($, self)
  try {
    await self.saving
  } finally {
    self.saving = null
  }
}

/** Writes the record, and again for as long as it changed while being written. */
async function saveLatest($: EngineInterface, self: Self): Promise<void> {
  do {
    self.isDirty = false
    const [rec, who] = [self.rec, self.who]
    if (rec === undefined || who === undefined) break
    await save($, who.stateDir, rec)
  } while (self.isDirty)
}

/** The research's last change is written once its second is up, so no count is left behind. */
function flushLater($: EngineInterface, self: Self): void {
  if (self.isFlushDue) return
  self.isFlushDue = true
  $.clock.after(RESEARCH_WRITE_MS, () => void flush($, self))
}

/** The session's title as the app gave it now, kept in the record when it is new. */
async function titled($: EngineInterface, self: Self, title: unknown): Promise<void> {
  if (typeof title !== 'string' || title === self.title) return
  self.title = title
  await emit($, self, at => ({ kind: 'title', at, title }))
}

/** Writes what of the research is not written yet. */
async function flush($: EngineInterface, self: Self): Promise<void> {
  self.isFlushDue = false
  try {
    if (self.rec === undefined || JSON.stringify(self.rec.research ?? null) === self.researchWritten) return
    await store($, self, await $.clock.now())
  } catch {
    // Written with the next change instead.
  }
}

/**
 * How loaded the machine is now, and what each agent and scoped container
 * costs it. Every session that shows the band or the pane wants the figures;
 * one of them measures and leaves the result for the rest.
 */
async function sampleUsage(
  $: EngineInterface,
  self: Self,
  stateDir: string,
  records: readonly AgentRecord[],
  scope: readonly string[],
  now: number,
): Promise<void> {
  if (self.sessionId === '') self.sessionId = await $.session.id()
  const panes = await $.ui.panes()
  const isWatching = panes.some(p => p.id === PANE && p.isPlaced) || (self.config.band && !(await read($, bandHidden)))
  const shared = parseShared(await $.fs.read(sharedFile(stateDir)).catch(() => ''))
  if (!shouldMeasure(shared, self.sessionId, isWatching, now)) {
    self.cpuSeconds = null
    self.system = null
    // Someone else's fresh figures, or none worth showing.
    self.usage = shared !== undefined && now - shared.at <= SHARED_FOR_MS * 2 ? shared.report : null

    return
  }
  if (self.polls % USAGE_EVERY !== 0 && self.usage !== null) return
  if (self.machine === undefined) self.machine = (await readMachine($)) ?? null
  const machine = self.machine
  if (machine === null) return
  const taken = await sample($, machine)
  const trees = records.map(r => ({ id: r.id, path: r.worktree }))
  const measured = measure(taken.procs, trees, self.cpuSeconds, now - self.sampledAt)
  const system = systemLoad(taken.system, self.system)
  self.cpuSeconds = measured.cpuSeconds
  self.system = taken.system ?? null
  self.sampledAt = now
  // A rate takes two readings: the first one only sets the mark.
  if (system === undefined) return
  if (scope.length === 0) self.containers = {}
  else if (self.polls % CONTAINERS_EVERY === 0) self.containers = await sampleContainers($, scope)
  self.usage = settle({
    system,
    agents: measured.usage,
    containers: self.containers,
    machine: { cores: machine.cores, ramBytes: machine.ramBytes },
  })
  await $.fs.write(sharedFile(stateDir), JSON.stringify({ at: now, by: self.sessionId, report: self.usage }))
}

/** The modes on offer in this session: built in, the person's, the project's. */
async function modesHere($: EngineInterface, self: Self): Promise<Mode[]> {
  if (!self.isLocated) await locateSelf($, self, await $.clock.now()).catch(() => undefined)

  const root = rootOf(self)

  return loadModes($, await $.env.get('HOME'), root === '' ? undefined : root)
}

/**
 * `/stage agent`: turns a working mode on or off, or says which there are.
 * The rules go to the agent as a note it reads with the person's next words.
 */
async function modeCommand($: EngineInterface, self: Self, wanted: string | undefined): Promise<{ text: string; context?: string[] }> {
  const modes = await modesHere($, self)
  const name = wanted?.toLowerCase()
  if (name === undefined || name === '') return { text: describeModes(modes, self.mode?.name, self.projectMode) }
  if (name === 'off') {
    const was = self.mode
    self.mode = null
    self.isModeDefault = false
    await update($, workMode, () => null)
    await update($, isWorkModeDefault, () => false)
    // The view the mode held goes back to the config's.
    if (was !== null) await update($, viewMode, () => null)
    await emit($, self, at => ({ kind: 'mode', at, name: null }))
    await refresh($, self)

    // Off is off for the session: the project's default waits for the next one.
    const stays = modes.some(m => m.name === self.projectMode) ? ` The project's default, ${self.projectMode ?? ''}, stays off until this session ends.` : ''

    return was === null ? { text: `No working mode was on.${stays}` } : { text: `Working mode "${was.name}" is off.${stays}`, context: [MODE_ENDED] }
  }
  const mode = modes.find(m => m.name === name)
  if (mode === undefined) return { text: `No working mode "${name}". ${describeModes(modes, self.mode?.name, self.projectMode)}` }
  self.mode = mode
  self.isModeDefault = false
  self.writtenAt = 0
  await update($, workMode, () => mode.name)
  await update($, isWorkModeDefault, () => false)
  await emit($, self, at => ({ kind: 'mode', at, name: mode.name, ...(mode.role === undefined ? {} : { role: mode.role }) }))
  // A mode is watched on the scene it names: its own agent's plan, or the team.
  await update($, viewMode, () => mode.view)
  await refresh($, self)
  await $.ui.open({ id: PANE, title: 'Agent Stage' })

  return {
    text: `Working mode "${mode.name}" is on (${mode.title}). Say what you want done.`,
    context: [modeBrief(mode)],
  }
}

/**
 * The mode the session starts in: the one kept over a reload, none if the
 * person turned it off, or else the project's default, which is then kept,
 * drawn, watched on its scene and told, once a session.
 */
async function startMode($: EngineInterface, self: Self, isInteractive: boolean): Promise<void> {
  try {
    // Never written: nothing was turned on or off in this session yet.
    const kept = (await $.state.get({ plugin: 'agent-stage-cc', key: 'workMode' } as const)).value
    const start = startingMode(await modesHere($, self).catch(() => []), kept, self.projectMode, await read($, isWorkModeDefault))
    self.mode = start?.mode ?? null
    self.isModeDefault = start?.isProjectDefault === true
    // A reload finds the default kept, and says nothing twice.
    if (start === null || !start.isProjectDefault || kept === start.mode.name) return
    const mode = start.mode
    await update($, workMode, () => mode.name)
    await update($, isWorkModeDefault, () => true)
    self.writtenAt = 0
    await emit($, self, at => ({ kind: 'mode', at, name: mode.name, ...(mode.role === undefined ? {} : { role: mode.role }) }))
    // Watched on the scene it names, unless the person picked one in this session.
    const picked = await $.state.get({ plugin: 'agent-stage-cc', key: 'viewMode' } as const)
    if (picked.value === undefined) await update($, viewMode, () => mode.view)
    if (isInteractive) $.ui.toast(`Working mode "${mode.name}" is on: the project's default. /stage agent off ends it.`)
  } catch {
    // A session starts whatever its mode; it can still be turned on by name.
  }
}

/**
 * The person's settings and the project's own patterns, read again now and
 * then so an edit takes hold without a restart. A missing file is the defaults.
 */
/** The project's folder: the repository's top, or the folder the session started in outside one. */
const rootOf = (self: Self) => self.who?.worktree ?? self.cwd

/** Looks again for the project's instruction files: AGENTS.md, CLAUDE.md. */
async function readRules($: EngineInterface, self: Self): Promise<void> {
  const root = rootOf(self)
  if (root === '') return
  self.rules = await findRules($, self.cwd === '' ? [root] : [root, self.cwd])
}

/** Where no rules are written down, the person hears once a session that init writes them. */
async function noteRules($: EngineInterface, self: Self, isInteractive: boolean): Promise<void> {
  if (!self.config.projectRules || !isInteractive || self.rules === null || hasRules(self.rules)) return
  if (self.mode?.name === 'init' || (await read($, isRulesNoted))) return
  await update($, isRulesNoted, () => true)
  $.ui.toast(NO_RULES_NOTICE)
}

async function loadConfig($: EngineInterface, self: Self): Promise<void> {
  const home = await $.env.get('HOME')
  const mine = home === undefined ? '' : await $.fs.read(`${home}/${GLOBAL_CONFIG}`).catch(() => '')
  self.config = mine === '' ? DEFAULTS : readConfig(mine)
  self.lang = self.config.language === 'auto' ? self.systemLang : self.config.language
  const root = rootOf(self)
  const theirs = root === '' ? '' : await $.fs.read(`${root}/${PROJECT_CONFIG}`).catch(() => '')
  const project = theirs === '' ? {} : readProjectConfig(theirs)
  self.projectMode = project.mode
  self.patterns = {
    test: project.test ?? DEFAULT_PATTERNS.test,
    coordinate: project.coordinate ?? DEFAULT_PATTERNS.coordinate,
  }
}

/** How much of the account's rate-limit windows is used, as Claude Code knows it. */
async function readLimits($: EngineInterface, self: Self): Promise<void> {
  if (self.polls % LIMITS_EVERY !== 1 && self.limits.length > 0) return
  try {
    const usage = await $.session.usage()
    self.limits = usage.rateLimits.map(l => ({
      kind: l.kind,
      percentUsed: l.percentUsed,
      ...(l.resetsAt === undefined ? {} : { resetsAt: l.resetsAt }),
    }))
  } catch {
    // Off a subscription there are no windows to show.
  }
}

/** Tells the person what just happened: natively where possible, else a toast. */
async function announce($: EngineInterface, self: Self, notices: readonly Notice[]): Promise<void> {
  const say = WORDS[self.lang].notice
  for (const notice of notices) {
    const text = notice.kind === 'released'
      ? say.released(notice.resource, notice.by)
      : notice.kind === 'question'
        ? notice.isUrgent ? say.urgent(notice.agent) : say.question(notice.agent)
        : say[notice.kind](notice.agent)
    const sent = await $.ui.notify(text, { title: 'Agent Stage' }).catch(() => undefined)
    if (sent?.isSent !== true) $.ui.toast(text)
  }
}

/** The band and the status line follow the brief; the lead session announces. */
async function brief($: EngineInterface, self: Self, next: Snapshot): Promise<void> {
  await readLimits($, self)
  const facts = toBrief(next, self.usage, self.limits)
  const key = JSON.stringify(facts)
  if (key !== self.briefShown) {
    self.briefShown = key
    await update($, briefNow, () => facts)
    $.ui.status(statusText(facts, WORDS[self.lang]))
  }
  if (self.isDemo) return
  const before = self.last
  self.last = next
  // One session speaks for the stage, or every session would say the same.
  if (before === null || self.who === undefined || next.coordinators[0] !== self.who.id) return
  const mine = self.who.id
  const notices = noticesBetween(before, next, self.config.notify).filter(n => n.kind === 'released' || n.agent !== mine)
  await announce($, self, notices)
}

/** A merge or a close happens on the forge, so an open PR is asked after. */
async function checkPr($: EngineInterface, self: Self): Promise<void> {
  const mine = self.rec
  if (mine?.pr === undefined) return
  const found = await prState($, mine.worktree, mine.pr.url)
  if (found === undefined) return
  self.writtenAt = 0
  await emit($, self, at => ({ kind: 'pr-state', at, ...found }))
}

async function refresh($: EngineInterface, self: Self): Promise<void> {
  try {
    const now = await $.clock.now()
    self.polls += 1
    if (self.polls % CONFIG_EVERY === 1) await loadConfig($, self)
    if (!self.isDemo && self.polls % PR_CHECK_EVERY === 0) await checkPr($, self)
    if (self.pane !== self.paneWritten && self.who !== undefined) {
      self.paneWritten = self.pane
      await $.fs.write(`${self.who.stateDir}/pane.json`, self.pane)
    }
    const mode = (await read($, viewMode)) ?? self.config.view
    // A pane that shows the research keeps the record of it from now on: held
    // to it, or left to a mode that is watched on it.
    if ((mode === 'research' || self.mode?.view === 'research') && !self.isDemo && self.rec !== undefined && self.rec.research === undefined) {
      await emit($, self, at => ({ kind: 'research-watch', at }))
    }
    let next: Snapshot
    if (self.isDemo) {
      next = self.demoKind === 'plan'
        ? demoPlanSnapshot(self.polls, now)
        : self.demoKind === 'research' ? demoResearchSnapshot(self.polls, now) : demoSnapshot(Math.floor(self.polls / 2), now)
      self.usage = demoUsage(next)
    } else {
      if (self.who === undefined) return
      const stateDir = self.who.stateDir
      const records = await prune($, stateDir, await loadAll($, stateDir), now)
      const resources = await loadResources($, stateDir)
      // The machine is asked only while someone watches and there is a scope.
      const scope = resources.flatMap(r => r.members)
      if (scope.length === 0) self.images = null
      else if (self.pane !== '' && (self.images === null || self.polls % INSPECT_EVERY === 0)) {
        self.images = await inspectImages($, scope)
      }
      await sampleUsage($, self, stateDir, records, scope, now)
      const views = resources.map(r => toResourceView(r, records, self.images, now))
      next = toSnapshot(records, now, { asleepAfterMs: self.config.asleepAfterMs }, views)
    }
    const shown = JSON.stringify(next)
    if (shown !== self.shown) {
      self.shown = shown
      await update($, snapshot, () => next)
    }
    await brief($, self, next)
    // The scene is redrawn only when what a person would see has changed.
    const stage = advance(self.stage, next, self.usage, now, { view: mode, ...(self.who === undefined ? {} : { self: self.who.id }) })
    if (stage !== self.stage) {
      self.stage = stage
      await update($, stageNow, () => stage)
    }
  } catch (error) {
    // A poll that fails is tried again on the next tick.
    self.trouble = `poll: ${error instanceof Error ? error.message : String(error)}`.slice(0, 300)
  }
}

/** What a person or a coordinator asks of a shared resource, in one place. */
async function resourceAction(
  $: EngineInterface,
  self: Self,
  input: Readonly<Record<string, unknown>>,
): Promise<{ text: string; isError: boolean }> {
  const fail = (text: string) => ({ text, isError: true })
  const now = await $.clock.now()
  if (!self.isLocated) await locateSelf($, self, now)
  if (self.who === undefined) return fail('Agent Stage keeps its state in a git repository; this session is not in one.')
  const action = ACTIONS.find(a => a === input.action)
  if (action === undefined) return fail(`action must be one of: ${ACTIONS.join(', ')}`)
  const stateDir = self.who.stateDir
  const records = await loadAll($, stateDir)
  const resources = await loadResources($, stateDir)
  const describe = (list: readonly ResourceView[]) =>
    [
      ...(list.length === 0 ? ['no shared resource is in use'] : list.map(describeResource)),
      ...records.map(r => `${r.id}: ${r.state}${r.role === 'coordinator' ? ' (coordinator)' : ''}${r.lastAction === '' ? '' : `, last: ${r.lastAction}`}`),
      ...(self.trouble === '' ? [] : [`trouble: ${self.trouble}`]),
    ].join('\n')
  if (action === 'status') {
    return { text: describe(resources.map(r => toResourceView(r, records, self.images, now))), isError: false }
  }

  const name = resourceName(typeof input.resource === 'string' ? input.resource : undefined)
  const rec = resources.find(r => r.name === name) ?? emptyResource(name, now)
  const ids = records.filter(r => r.state !== 'done').map(r => r.id)
  const named = (query: unknown) => resolveAgent(ids, typeof query === 'string' && query.trim() !== '' ? query : self.who?.id ?? '')
  let op: ResourceOp
  let scope = rec.members
  if (action === 'grant' || action === 'queue' || action === 'unqueue') {
    const who = named(input.agent)
    if ('error' in who) return fail(who.error)
    op = { kind: action, agent: who.id }
  } else if (action === 'order') {
    const order: string[] = []
    for (const query of strings(input.agents)) {
      const who = named(query)
      if ('error' in who) return fail(who.error)
      order.push(who.id)
    }
    op = { kind: 'order', agents: order }
  } else if (action === 'scope') {
    scope = strings(input.containers)
    op = { kind: 'scope', containers: scope }
  } else {
    op = { kind: 'release' }
  }
  // A grant and a scope take the machine's word for what runs now.
  const images = action === 'grant' || action === 'scope' ? await inspectImages($, scope) : null
  const next = applyOp(rec, op, now, images ?? {})
  await saveResource($, stateDir, next, await $.session.id())
  if (images !== null) self.images = { ...(self.images ?? {}), ...images }
  await refresh($, self)
  const unknown = action === 'scope' && images !== null ? next.members.filter(m => images[m] === undefined) : []
  const note = action === 'scope' && images === null
    ? '\ndocker did not answer, so swapped images cannot be shown'
    : unknown.length > 0 ? `\nno such container: ${unknown.join(', ')}` : ''

  return { text: `${describeResource(toResourceView(next, records, self.images, now))}${note}`, isError: false }
}

export const register: Register = on => {
  const self: Self = {
    who: undefined, rec: undefined, written: '', writtenAt: 0, isLocated: false,
    researchWritten: 'null', title: undefined, isFlushDue: false, saving: null, isDirty: false,
    shown: '', stage: null, polls: 0, isDemo: false, demoKind: 'team', mode: null, isModeDefault: false, projectMode: undefined, cwd: '', rules: null, lang: 'en', systemLang: 'en', utcOffsetMinutes: 0,
    pane: '', paneWritten: '', images: null, config: DEFAULTS, patterns: DEFAULT_PATTERNS, last: null, briefShown: '',
    machine: undefined, cpuSeconds: null, system: null, sampledAt: 0, containers: {}, usage: null, limits: [], sessionId: '', trouble: '',
  }

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'stage',
      description: 'Open the Agent Stage pane',
      argumentHint: '[agent <mode>|demo [plan|research]|live|view <auto|team|plan|research>|band|status|grant <agent>|release|queue <agent>|order <agents>]',
    })
    await $.tool.register({
      name: 'resource',
      description: TOOL_DESCRIPTION,
      inputSchema: TOOL_SCHEMA,
      isDeferred: false,
    })
    await readLocale($, self)
    // Located first, so that the project's own file is read with the person's.
    self.cwd = await $.session.cwd().catch(() => '')
    if (!self.isLocated) await $.clock.now().then(at => locateSelf($, self, at)).catch(() => undefined)
    await loadConfig($, self).catch(() => undefined)
    await readRules($, self).catch(() => undefined)
    self.isDemo = await read($, demo)
    const sessionId = await $.session.id()
    await emit($, self, at => ({ kind: 'session-start', at, sessionId }))
    await startMode($, self, e.isInteractive)
    await noteRules($, self, e.isInteractive).catch(() => undefined)
    // A title heard before the session's start was the session's own: the start set the record anew.
    if (self.title !== undefined) {
      const title = self.title
      await emit($, self, at => ({ kind: 'title', at, title }))
    }
    void refresh($, self)
    $.clock.every(self.config.refreshMs, () => void refresh($, self))

    return next(e)
  })

  // The session's title, as the app lists the session: the stage names the agent by it.
  on('classic.SessionStart', async ($, e, next) => {
    await titled($, self, e.session_title)

    return next(e)
  }).catch(($, e, next) => next(e))
  on('classic.UserPromptSubmit', async ($, e, next) => {
    await titled($, self, e.session_title)

    return next(e)
  }).catch(($, e, next) => next(e))

  // How to keep the stage's record, told once in each session's instructions.
  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    // The project's rules come first: AGENTS.md, or a nudge to write one. Looked for anew, since init may have written them.
    await readRules($, self).catch(() => undefined)
    const said = self.config.projectRules && self.rules !== null ? rulesBrief(self.rules, self.mode?.name === 'init') : undefined
    const rules = said === undefined ? [] : [{ id: 'agent-stage-cc:rules', text: said, scope: 'session' as const }]
    // A working mode's rules head every new thread while the mode is on.
    const mode = self.mode === null ? [] : [{ id: 'agent-stage-cc:mode', text: modeBrief(self.mode, self.isModeDefault), scope: 'session' as const }]
    const guide = self.config.guide ? [{ id: 'agent-stage-cc:guide', text: GUIDE, scope: 'session' as const }] : []

    return { sections: [...composed.sections, ...rules, ...guide, ...mode] }
  })

  on('session.end', async ($, e, next) => {
    self.writtenAt = 0
    await emit($, self, at => ({ kind: 'session-end', at }))

    return next(e)
  })

  // A subagent the session starts is a probe of its research, named by what it was sent for.
  on('agent.spawn', async ($, e, next) => {
    const started = await next(e)
    const id = started.agentId
    if (id !== undefined) {
      const label = e.description.trim() || e.name?.trim() || e.subagentType
      self.writtenAt = 0
      await emit($, self, at => ({ kind: 'probe-start', at, id, label, isBackground: e.background }))
    }

    return started
  }).catch(($, e, next) => next(e))

  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) {
      // What is not written yet is written before the record is read again.
      await flush($, self)
      self.isLocated = false
      await emit($, self, at => ({ kind: 'turn-start', at }))
    } else {
      // A probe woken for another turn is at work again.
      const id = e.agentId
      void emit($, self, at => ({ kind: 'probe-start', at, id }))
    }

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const id = e.agentId
    if (id === undefined) {
      self.writtenAt = 0
      await emit($, self, at => ({ kind: 'turn-end', at, answer: e.answer, reason: e.reason }))
    } else if (self.rec?.research?.probes.some(p => p.id === id) === true) {
      // A probe is done when its own turn ends, and the stage is told at once.
      self.writtenAt = 0
      await emit($, self, at => ({ kind: 'probe-end', at, id, reason: e.reason }))
    }

    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    const tool = String(e.tool)
    const call = e as unknown as Record<string, unknown>
    const action = classify(tool, call, self.patterns)
    // A search counts where it runs: in a probe's loop, or the session's own.
    const where = { ...(e.agentId === undefined ? {} : { loop: e.agentId }), ...(isSearchCall(tool, action) ? { isSearch: true } : {}) }
    await emit($, self, at => ({ kind: 'tool-start', at, action, ...where }))
    let ran: ToolCallResult
    try {
      ran = await next(e)
    } catch (error) {
      // A call that broke off still ends, so nothing stays counted as running;
      // broken off, as when the person stops a test run, is not failed.
      await emit($, self, at => ({ kind: 'tool-end', at, action, isError: false, ...where }))
      throw error
    }
    const isError = ran.deny !== undefined || ran.isError === true
    const output = ran.deny === undefined && typeof ran.text === 'string' ? ran.text : ''
    const found = where.isSearch === true && !isError ? sourcesOf(tool, call, ran.result, output) : []
    await emit($, self, at => ({ kind: 'tool-end', at, action, isError, output, ...where, ...(found.length > 0 ? { found } : {}) }))
    // A subagent's own list is not the session's plan; the tasks it files are.
    if (!isError && isPlanTool(String(e.tool)) && (e.agentId === undefined || isSessionList(String(e.tool)))) {
      const input = e as unknown as Record<string, unknown>
      self.writtenAt = 0
      await emit($, self, at => ({ kind: 'plan-call', at, tool: String(e.tool), input, result: ran.result }))
    }

    return ran
    // Watching must never cost a tool call: a failure here hands the call on.
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: TOOL }, async ($, e) => {
    const done = await resourceAction($, self, e as unknown as Record<string, unknown>)

    return done.isError ? { result: done.text, isError: true } : { result: done.text }
  })

  on('command.run', { command: 'stage' }, async ($, e) => {
    const [wanted = '', ...rest] = e.args.trim().split(/\s+/)
    const verb = wanted.toLowerCase()
    let said = ''
    if (verb === 'band') {
      const hidden = !(await read($, bandHidden))
      await update($, bandHidden, () => hidden)

      return { text: hidden ? 'Agent Stage band hidden.' : 'Agent Stage band shown.' }
    }
    if (verb === 'agent') return modeCommand($, self, rest[0])
    if (verb === 'view') {
      const picked = viewOf(rest[0]?.toLowerCase())
      if (picked === undefined) return { text: 'Usage: /stage view auto|team|plan|research' }
      await update($, viewMode, () => picked)
      await refresh($, self)
      // Asked for a plan where nobody keeps one, the pane would show the team unexplained.
      const research = self.stage?.research ?? null
      const shown = research !== null
        ? `the research of ${research.agent.id}`
        : (self.stage?.plan ?? null) === null ? 'the team' : `the plan of ${self.stage?.plan?.agent.id ?? ''}`
      said = picked === 'plan' && (self.stage?.plan ?? null) === null
        ? ' View: plan. No agent keeps a task list right now, so the team is shown until one does.'
        : ` View: ${picked}, showing ${shown}.`
    } else if (verb === 'demo' || verb === 'live') {
      self.isDemo = verb === 'demo'
      const kind = rest[0]?.toLowerCase()
      self.demoKind = kind === 'plan' || kind === 'research' ? kind : 'team'
      self.stage = null
      // Figures of the other mode are not this one's.
      self.usage = null
      self.cpuSeconds = null
      self.system = null
      self.last = null
      await update($, demo, () => self.isDemo)
      await refresh($, self)
    } else if ((ACTIONS as readonly string[]).includes(verb)) {
      const action = verb as ResourceAction
      const done = await resourceAction($, self, {
        action,
        ...(action === 'order' ? { agents: rest } : action === 'scope' ? { containers: rest } : rest[0] === undefined ? {} : { agent: rest[0] }),
      })

      return { text: done.text }
    }
    const opened = await $.ui.open({ id: PANE, title: 'Agent Stage' })
    const mode = self.isDemo ? ' (demo data)' : ''

    return { text: opened.isPlaced ? `Agent Stage opened${mode}.${said}` : `Agent Stage did not open: ${opened.reason}` }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const stage = await read($, stageNow)
    const toggles = await read($, view)
    const { Box, Text, Button } = $.ui.resolve(e)
    const words = WORDS[self.lang]

    if (stage === null) return <Text dimColor>{words.worktrees(0)}</Text>

    // A surface without a vector element gets the same facts as a list.
    const marks = { done: '✓', active: '▸', pending: '·' } as const
    const research = stage.research ?? null
    // The research's own plan is its phases: listed as a plan's steps are.
    const steps = stage.plan?.steps ?? (research?.agent.plan ?? []).map((s, i) => ({ key: `${i}`, ordinal: i + 1, text: s.text, status: s.status }))
    const list = (
      <Box flexDirection="column">
        {(research === null ? [] : researchRows(research, self.lang)).map(row => (
          <Text key={row.key} color={row.tone === 'bad' ? BAD : row.tone === 'ask' ? ASK : undefined} dimColor={row.isDim === true}>
            {row.text}
          </Text>
        ))}
        {steps.map(s => (
          <Text key={`step-${s.key}`} dimColor={s.status === 'pending'}>
            {marks[s.status]} {s.ordinal}. {s.text}
          </Text>
        ))}
        {[...(stage.coordinator === null ? [] : [stage.coordinator]), ...stage.agents].map(a => (
          <Text color={a.needsAttention ? '#ff5fa2' : undefined} dimColor={a.isAsleep}>
            {nameOf(a, 60)} · {a.isAsleep ? words.asleep : words.state[a.state]}
            {(a.subagents?.length ?? 0) === 0 ? '' : ` · ${words.subagents(a.subagents?.length ?? 0)}`}
            {a.lastAction === '' ? '' : ` · ${a.lastAction}`}
          </Text>
        ))}
      </Box>
    )
    if (e.surface === 'terminal') return list

    const plan = stage.plan ?? null
    const researchFit = research === null ? null : fitResearch(e.props.bodyColumns, e.props.scroll.bodyRows)
    const planFit = plan === null || researchFit !== null ? null : fitPlan(e.props.bodyColumns, e.props.scroll.bodyRows, stage.resource !== null)
    const { layout, pixelWidth, pixelHeight } = researchFit ?? planFit ?? fitLayout(e.props.bodyColumns, e.props.scroll.bodyRows, stage.resource !== null)
    self.pane = JSON.stringify({
      bodyColumns: e.props.bodyColumns,
      bodyRows: e.props.scroll.bodyRows,
      viewport: e.viewport ?? null,
      pixelWidth,
      pixelHeight,
    })
    const options = { ...toggles, lang: self.lang, utcOffsetMinutes: self.utcOffsetMinutes, pixelWidth, pixelHeight }
    const source = research !== null && researchFit !== null
      ? renderResearch(stage, research, researchFit.layout, neon, options)
      : plan !== null && planFit !== null
        ? renderPlan(stage, plan, planFit.layout, neon, options)
        : renderScene(stage, layout as Layout, neon, options)
    if (source.length > MAX_SOURCE) return list
    const { Svg } = $.ui.resolve(e)
    const names = TOGGLES[self.lang]
    const picked = (await read($, viewMode)) ?? self.config.view
    const toggle = (key: keyof ViewToggles) => (
      <Button
        key={key}
        label={`${toggles[key] ? '●' : '○'} ${names[key]}`}
        onPress={() => update($, view, v => ({ ...(v ?? ALL_ON), [key]: !(v ?? ALL_ON)[key] }))}
      />
    )

    return (
      <Box flexDirection="column" gap={1}>
        <Box gap={1}>
          {toggle('focus')}
          {toggle('labels')}
          {toggle('links')}
          <Button
            key="view"
            label={`◐ ${VIEWS[self.lang][picked]}${picked === 'plan' && plan === null ? NO_PLAN[self.lang] : ''}`}
            onPress={async () => {
              await update($, viewMode, () => NEXT_VIEW[picked])
              await refresh($, self)
            }}
          />
        </Box>
        <Svg
          source={source}
          alt={describeScene(stage, self.lang)}
          width={pixelWidth}
          height={pixelHeight}
          isInteractive
        />
      </Box>
    )
  })

  // The standing brief above the prompt: bare figures, each in its own
  // color; a pointer over one says what it is.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const facts = await read($, briefNow)
    const isHidden = await read($, bandHidden)
    if (e.props.hasSurvey || isHidden || !self.config.band || facts === null) return next(e)
    const words = WORDS[self.lang]
    const items = bandItems(facts, words)
    if (items.length === 0) return next(e)
    const { Box, Text, Button } = $.ui.resolve(e)

    return (
      <Box gap={2}>
        {items.map(item => (
          <Box key={`stage-${item.key}`}>
            <Text color={TONES[item.tone]}>{item.text}</Text>
            <Box display="none" hover={{ display: 'flex' }}>
              <Text dimColor> {item.hint}</Text>
            </Box>
          </Box>
        ))}
        <Box gap={1}>
          <Button
            key="stage-open"
            plain
            label={words.scene}
            onPress={async () => {
              await $.ui.open({ id: PANE, title: 'Agent Stage' })
            }}
          />
          <Button key="stage-hide" plain role="dismiss" label="×" onPress={() => update($, bandHidden, () => true)} />
        </Box>
      </Box>
    )
  })
}
