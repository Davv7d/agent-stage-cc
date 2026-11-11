import type { ViewMode } from '../../types'

/** Which events raise a notification. */
export type NotifyEvents = {
  /** An agent asked the person something. */
  question: boolean
  /** An agent's tests failed. */
  failed: boolean
  /** A shared resource was released. */
  released: boolean
  /** An agent opened a pull request. */
  pr: boolean
}

/**
 * What a person may tune. Every value has a default, so the mod works with
 * no configuration at all.
 */
export type Config = {
  /** The row above the prompt. */
  band: boolean
  /** A short section in each session's instructions on keeping the stage's record. */
  guide: boolean
  /** Which scene the pane shows: the team, one agent's plan, or whichever fits. */
  view: ViewMode
  /** The language of the scene and the band: the system's, unless one is named. */
  language: 'auto' | 'en' | 'pl'
  notify: NotifyEvents
  /** How often the shared state is read, in milliseconds. */
  refreshMs: number
  /** An idle agent quiet for this long is shown asleep. */
  asleepAfterMs: number
}

export const DEFAULTS: Config = {
  band: true,
  guide: true,
  view: 'auto',
  language: 'auto',
  notify: { question: true, failed: true, released: true, pr: false },
  refreshMs: 3000,
  asleepAfterMs: 30 * 60_000,
}

/** What a project says about itself, in a file it commits: `.agent-stage-cc.json`. */
export type ProjectConfig = {
  /** Regular expressions: a shell command matching one runs tests. */
  testCommands?: string[]
  /** Regular expressions: a tool whose name matches one hands work to another agent. */
  coordinatorTools?: string[]
}

export const GLOBAL_CONFIG = '.config/agent-stage-cc/config.json'
export const PROJECT_CONFIG = '.agent-stage-cc.json'

/** A view by its name; undefined for anything else. */
export const viewOf = (value: unknown): ViewMode | undefined =>
  value === 'auto' || value === 'team' || value === 'plan' ? value : undefined

const bool = (value: unknown, fallback: boolean) => (typeof value === 'boolean' ? value : fallback)
const within = (value: unknown, low: number, high: number, fallback: number) =>
  typeof value === 'number' && Number.isFinite(value) ? Math.min(high, Math.max(low, value)) : fallback

/**
 * A person's config file over the defaults. Anything missing, mistyped or
 * out of range keeps its default: a bad file never stops the mod.
 */
export function readConfig(text: string): Config {
  let raw: Record<string, unknown> = {}
  try {
    const parsed: unknown = JSON.parse(text)
    if (typeof parsed === 'object' && parsed !== null) raw = parsed as Record<string, unknown>
  } catch {
    return DEFAULTS
  }
  const notify = (typeof raw.notify === 'object' && raw.notify !== null ? raw.notify : {}) as Record<string, unknown>

  return {
    band: bool(raw.band, DEFAULTS.band),
    guide: bool(raw.guide, DEFAULTS.guide),
    view: viewOf(raw.view) ?? DEFAULTS.view,
    language: raw.language === 'en' || raw.language === 'pl' ? raw.language : DEFAULTS.language,
    notify: {
      question: bool(notify.question, DEFAULTS.notify.question),
      failed: bool(notify.failed, DEFAULTS.notify.failed),
      released: bool(notify.released, DEFAULTS.notify.released),
      pr: bool(notify.pr, DEFAULTS.notify.pr),
    },
    refreshMs: within(raw.refreshSeconds === undefined ? undefined : Number(raw.refreshSeconds) * 1000, 1000, 60_000, DEFAULTS.refreshMs),
    asleepAfterMs: within(raw.asleepAfterMinutes === undefined ? undefined : Number(raw.asleepAfterMinutes) * 60_000, 60_000, 24 * 3_600_000, DEFAULTS.asleepAfterMs),
  }
}

const patterns = (value: unknown): RegExp[] | undefined => {
  if (!Array.isArray(value)) return undefined
  const found: RegExp[] = []
  for (const source of value) {
    if (typeof source !== 'string' || source.length > 300) continue
    try {
      found.push(new RegExp(source))
    } catch {
      // A pattern that does not compile is left out; the rest still count.
    }
  }

  return found
}

/** A project's patterns as the classifier takes them; undefined keeps the built-in ones. */
export function readProjectConfig(text: string): { test?: RegExp[]; coordinate?: RegExp[] } {
  try {
    const parsed: unknown = JSON.parse(text)
    if (typeof parsed !== 'object' || parsed === null) return {}
    const raw = parsed as Record<string, unknown>
    const test = patterns(raw.testCommands)
    const coordinate = patterns(raw.coordinatorTools)

    return { ...(test === undefined ? {} : { test }), ...(coordinate === undefined ? {} : { coordinate }) }
  } catch {
    return {}
  }
}

/**
 * What every session is told about the stage. It teaches the tool, not a
 * policy: who may use a shared resource is the person's and the project's to
 * say, and the mod only keeps the record of it.
 */
export const GUIDE = `# Agent Stage

This session is shown on the Agent Stage, a live view of every agent working in this repository's worktrees. What you are doing is read automatically from your actions: never report your own state.

The stage also records who holds a shared resource that only one agent should use at a time (named \`stack\` unless said otherwise, for example a local stack of containers) and who waits for it. It only records and shows: it blocks nothing, and who may use the resource is decided by the person, the coordinating session and this project's own instructions. Keep the record true with the \`mcp__agent-stage-cc__resource\` tool:

- If you coordinate other sessions: \`grant\` with the agent's worktree name when the resource is assigned to it, \`queue\` when an agent has to wait, \`order\` to rearrange the line, \`release\` when the holder is done.
- If the resource is given to you: before changing anything, \`scope\` with the names of the containers you will touch, so swapped images can be told from the originals; \`release\` once you are finished.
- \`status\` reads every agent's state and who holds the resource.

Where this project uses no shared resource, this section does not apply.

If you keep a task list for your work, the stage shows its steps and how far you are; nothing more is asked of you.`
