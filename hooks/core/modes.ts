import type { EngineInterface } from 'claude-code'

import type { ViewMode } from '../../types'
import { INIT } from './init'

// A working mode is a way of working, written down: rules a person turns on
// for a session with `/stage agent <name>`. The mod hands the rules to the
// agent and draws what the agent then does; it knows nothing of what they
// say. Two modes come built in; a person's own and a project's are files.

export type Mode = {
  name: string
  title: string
  /** The rules, as the agent reads them. */
  text: string
  from: 'built-in' | 'yours' | 'project'
  /** The scene the pane is held to while the mode is on: the agent's plan unless the file says `view: team` or `view: research`. */
  view: ViewMode
  /** `coordinator` when the file says `role: coordinator`: the session is drawn as one from the start. */
  role?: 'coordinator'
}

/** A person's modes, under their home folder: one Markdown file per mode. */
export const GLOBAL_MODES = '.config/agent-stage-cc/modes'
/** A project's modes, in the repository: they win over a person's of the same name. */
export const PROJECT_MODES = '.agent-stage-cc/modes'

const MAX_TEXT = 12_000

/** A mode's name from its file's: lowercase letters, digits and dashes. */
export const modeName = (file: string): string | undefined => /^([a-z0-9][a-z0-9-]{0,39})\.md$/.exec(file)?.[1]

/**
 * A file's text as a mode; its first heading, if any, is the title. A file
 * may open with a few settings between two lines of `---`: `view: team`,
 * `view: research` and `role: coordinator` are read, and none of it reaches
 * the agent.
 */
export function toMode(name: string, written: string, from: Mode['from']): Mode | undefined {
  const text = written.replace(/\r\n?/g, '\n')
  const head = /^\s*---\n([\s\S]*?)\n---[ \t]*(\n|$)/.exec(text)
  const settings = new Map<string, string>()
  for (const line of (head?.[1] ?? '').split('\n')) {
    const found = /^\s*([a-z]+)\s*:\s*(\S+)\s*$/.exec(line)
    if (found) settings.set(found[1] ?? '', found[2] ?? '')
  }
  const rules = (head === null ? text : text.slice(head[0].length)).trim().slice(0, MAX_TEXT)
  if (rules === '') return undefined
  const title = /^#\s+(.+)$/m.exec(rules)?.[1]?.trim() ?? name
  const view = settings.get('view')

  return {
    name,
    title,
    text: rules,
    from,
    view: view === 'team' || view === 'auto' || view === 'research' ? view : 'plan',
    ...(settings.get('role') === 'coordinator' ? { role: 'coordinator' as const } : {}),
  }
}

const PLAN = `# Plan first, then work

Work in this session goes through the phases below, in order. Nothing is built before the person has accepted a proposal.

Keep the phases as your task list from the very first step, one task per phase, named as below. Mark a phase in progress when you begin it and done when it is finished. The Agent Stage draws that list, so the person sees where the work stands without asking.

1. **Context.** Before anything else, read what the project says about itself: its agent instructions (AGENTS.md, CLAUDE.md and the files they point to), and the skills and documents that bear on the task. Change nothing yet.
2. **Requirements.** Establish what is wanted. Restate the task in your own words, name what is unclear and ask about it, and note the constraints you found. Where an answer would change the work, ask instead of assuming.
3. **Proposal.** Say how you would do it: the approach, the steps, what will be touched, what could go wrong. Then stop and wait. Do not begin the work in the same turn as the proposal.
4. **Implementation.** Only once the proposal is accepted. Add the accepted steps to the task list as tasks of their own and work through them one at a time, keeping each one's state true.
5. **Check.** Verify what was built in the way the project verifies its work, and report what was done, what was not, and what was not checked.

If the person changes the task or rejects the proposal, go back to the phase that is affected and say so.`

const FULL = `# The whole task in one run

Work in this session is done in one run, in stages, without stopping for approval between them. Stop only for something that is truly the person's to decide, or that cannot be undone.

Keep the stages as your task list from the very first step, one task per stage. Mark a stage in progress when you begin it and done when it is finished. The Agent Stage draws that list, so the person can watch the work move.

1. **Context.** Read what the project says about itself: its agent instructions (AGENTS.md, CLAUDE.md and the files they point to), and the skills and documents that bear on the task.
2. **Plan.** Decide the approach and say it in a few lines. Add its steps to the task list as tasks of their own. Do not wait for an answer.
3. **Implementation.** Work through the steps one at a time, keeping each one's state true.
4. **Check.** Verify what was built in the way the project verifies its work.
5. **Summary.** Report what was done, what was not, and what was not checked.`

const RESEARCH = `---
view: research
---
# Research a topic

In this session you research. The person names a topic; you find out what is known about it from sources you read, not from memory, and report it so that every claim can be followed back to where it came from.

Keep the phases as your task list from the very first step, one task per phase, named as below, and each sub-question of the research plan as a task of its own. Mark a task in progress when you begin it and done when it is finished. The Agent Stage draws that list and the searches as they run, so the person sees where the research stands without asking.

1. **Question.** Restate the topic in your own words: what is asked, how far it reaches, and what the answer is for. Ask where the report should go: in the chat, or in a file, for which suggest \`research/<slug>.md\`; create the file only if the person agrees. Where the depth is unclear, ask whether a quick look or a thorough study is wanted. Wait for the answers before you search, unless the person has already given them.
2. **Research plan.** Split the topic into sub-questions that can be answered independently of one another, and add each to the task list as a task of its own. Say in a line what each one is for.
3. **Gathering.** Answer the sub-questions in parallel: one subagent per sub-question, at most five at a time unless the person says otherwise. Describe each subagent's task by its sub-question, in a few words. Give each a brief that stands on its own: the sub-question, why it matters, what is already known, which kinds of sources to prefer, and what to bring back: the findings, the address of each source, and the date of anything that may change. Tell each to run its searches and reads in parallel wherever one does not depend on another. Mark a sub-question done when its findings are in.
4. **Verification.** Check each key claim against at least two independent sources; a page that repeats another is not a second source. Name every contradiction, and say which side the evidence favours, if either. Date each fact that changes with time, such as a price, a version, a figure or who holds a post.
5. **Report.** The answer first, in a few sentences. Then the findings, each with links to its sources; then what is uncertain, and what was not checked. Put the report where the person asked for it.

If the person narrows or widens the topic, go back to the research plan and say what changes.`

const COORDINATE = `---
view: team
role: coordinator
---
# Coordinate other agents

In this session you coordinate. The person brings tasks to you; other agents, each in a session and a worktree of its own, do the work. You hand the work out, watch over it and keep the person informed. Do not do an agent's work yourself, unless the person asks you to or the piece is too small to hand out.

Keep a task list of what is in flight, one task per piece of work handed out, named so that the person can tell which agent has it. Mark a task in progress while its agent works and done when its result is in. The Agent Stage shows every agent and the state it is in; your list says what each of them is for.

1. **Take the task in.** Read what the project says about itself (AGENTS.md, CLAUDE.md and the files they point to, and the skills that bear on the task), far enough to split the work well. Ask the person about what is unclear before handing anything out.
2. **Split and hand out.** Divide the work into pieces that can be done independently and start one agent for each, in the way this project starts agents. Give each a brief that stands on its own: the goal, the files or the area, what done looks like, and what it must not touch.
3. **Watch over.** Follow the agents' progress. Answer their questions where you can; bring to the person the ones that are theirs to answer, and say which agent is waiting. Notice an agent that is stuck, has failed its tests or has gone quiet.
4. **Keep the shared resource in order.** Where the project has something only one agent may use at a time, such as a local stack of containers, you keep the record of it with the stage's \`resource\` tool: \`grant\` it to the agent whose turn it is, \`queue\` the ones that wait, \`order\` the line when priorities change, and \`release\` it when the holder is done. Who goes first is decided by the person's instructions and the project's rules; where they say nothing, first come, first served. Tell an agent when the resource is its to use, and remind the holder to report its \`scope\` before it changes anything.
5. **Bring the results in.** When an agent finishes, check what it reports against what was asked, in the way the project reviews work, and tell the person what is ready, what is not, and what needs their decision.`

export const BUILT_IN: readonly Mode[] = [
  toMode('plan', PLAN, 'built-in'),
  toMode('full', FULL, 'built-in'),
  toMode('research', RESEARCH, 'built-in'),
  toMode('coordinate', COORDINATE, 'built-in'),
  toMode('init', INIT, 'built-in'),
].filter((m): m is Mode => m !== undefined)

async function modesIn($: EngineInterface, dir: string, from: Mode['from']): Promise<Mode[]> {
  const entries = await $.fs.list(dir).catch(() => [])
  const found: Mode[] = []
  for (const entry of entries) {
    const name = entry.kind === 'file' ? modeName(entry.name) : undefined
    if (name === undefined) continue
    const mode = toMode(name, await $.fs.read(`${dir}/${entry.name}`).catch(() => ''), from)
    if (mode !== undefined) found.push(mode)
  }

  return found
}

/** A later mode of the same name takes the place of an earlier one. */
export function mergeModes(...lists: readonly (readonly Mode[])[]): Mode[] {
  const byName = new Map<string, Mode>()
  for (const mode of lists.flat()) byName.set(mode.name, mode)

  return [...byName.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
}

/** Every mode on offer here: the built-in ones, the person's, the project's. */
export async function loadModes($: EngineInterface, home: string | undefined, worktree: string | undefined): Promise<Mode[]> {
  const mine = home === undefined ? [] : await modesIn($, `${home}/${GLOBAL_MODES}`, 'yours')
  const theirs = worktree === undefined ? [] : await modesIn($, `${worktree}/${PROJECT_MODES}`, 'project')

  return mergeModes(BUILT_IN, mine, theirs)
}

/** What the agent is told when a mode is turned on, and at the head of each new thread. */
export const modeBrief = (mode: Mode, isProjectDefault = false) =>
  `# Agent Stage: working mode \`${mode.name}\`

${isProjectDefault
    ? `This project starts every session in the working mode \`${mode.name}\` (its \`.agent-stage-cc.json\` says so), and this session is in it; the person can end it with \`/stage agent off\`.`
    : `The person turned on the working mode \`${mode.name}\` for this session.`} From now on work by the rules below, until the person says otherwise. They say how to keep your task list: the Agent Stage draws it for the person as you go.

${mode.text}`

export const MODE_ENDED = 'The person turned the Agent Stage working mode off. Its rules no longer apply; work as you otherwise would.'

/**
 * The mode a session starts with. One the person turned on in the session wins
 * over the project's default, and one they turned off stays off until the
 * session ends. `kept` is what the session holds: a mode's name, null once the
 * person turned the mode off, undefined while nothing was turned on or off;
 * `isKeptDefault`, that the kept mode was the project's default. A kept name
 * that is no longer on offer leaves the project's default to stand.
 */
export function startingMode(
  modes: readonly Mode[],
  kept: string | null | undefined,
  projectDefault: string | undefined,
  isKeptDefault = false,
): { mode: Mode; isProjectDefault: boolean } | null {
  if (kept === null) return null
  const chosen = modes.find(m => m.name === kept)
  if (chosen !== undefined) return { mode: chosen, isProjectDefault: isKeptDefault }
  const fallback = modes.find(m => m.name === projectDefault)

  return fallback === undefined ? null : { mode: fallback, isProjectDefault: true }
}

/** What `/stage agent` says of the project's default mode; nothing where the project names none. */
export const describeDefault = (modes: readonly Mode[], name: string | undefined) =>
  name === undefined
    ? ''
    : modes.some(m => m.name === name)
      ? ` The project's default: ${name}.`
      : ` The project's default "${name}" is not a mode on offer, so it was not turned on.`

/** The modes as one line for a person: each name and where it comes from. */
export const describeModes = (modes: readonly Mode[], current: string | undefined, projectDefault?: string) =>
  `Working modes: ${modes.map(m => `${m.name} (${m.from})`).join(', ')}. ${current === undefined ? 'None is on.' : `On now: ${current}.`}${describeDefault(modes, projectDefault)} Start one with /stage agent <name>, end it with /stage agent off.`
