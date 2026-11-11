import type { EngineInterface } from 'claude-code'

import type { ViewMode } from '../../types'

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
  /** The scene the pane is held to while the mode is on: the agent's plan unless the file says `view: team`. */
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
 * may open with a few settings between two lines of `---`: `view: team` and
 * `role: coordinator` are read, and none of it reaches the agent.
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
    view: view === 'team' || view === 'auto' ? view : 'plan',
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
  toMode('coordinate', COORDINATE, 'built-in'),
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
export const modeBrief = (mode: Mode) =>
  `# Agent Stage: working mode \`${mode.name}\`

The person turned on the working mode \`${mode.name}\` for this session. From now on work by the rules below, until the person says otherwise. They say how to keep your task list: the Agent Stage draws it for the person as you go.

${mode.text}`

export const MODE_ENDED = 'The person turned the Agent Stage working mode off. Its rules no longer apply; work as you otherwise would.'

/** The modes as one line for a person: each name and where it comes from. */
export const describeModes = (modes: readonly Mode[], current: string | undefined) =>
  `Working modes: ${modes.map(m => `${m.name} (${m.from})`).join(', ')}. ${current === undefined ? 'None is on.' : `On now: ${current}.`} Start one with /stage agent <name>, end it with /stage agent off.`
