import type { EngineInterface } from 'claude-code'

// A project's rules live in files any agent reads, whatever assistant it is:
// AGENTS.md first, and the skills it points to. The mod looks for them when a
// session starts, tells the agent they come first, and where a project has
// none, has the agent suggest writing them.

/** What instruction files a project holds, where its sessions start. */
export type Rules = {
  /** `AGENTS.md`: the rules any agent reads. */
  hasAgents: boolean
  /** A CLAUDE.md of the project's: Claude Code then reads it instead of AGENTS.md. */
  hasClaude: boolean
  /** That CLAUDE.md brings AGENTS.md in with an `@AGENTS.md` line. */
  isAgentsImported: boolean
}

/** Claude Code's own instruction files: any of them stops it reading AGENTS.md by itself. */
const CLAUDE_FILES = ['CLAUDE.md', '.claude/CLAUDE.md', 'CLAUDE.local.md']

/** A line that imports AGENTS.md into a CLAUDE.md. */
const IMPORT = /^[ \t]*@(?:\.\/)?AGENTS\.md[ \t]*$/m

/**
 * The instruction files in the folders a session works in: the project's
 * root and, where the session started deeper in, that folder too.
 */
export async function findRules($: EngineInterface, folders: readonly string[]): Promise<Rules> {
  const exists = (path: string) => $.fs.exists(path).catch(() => false)
  let hasAgents = false
  let hasClaude = false
  let isAgentsImported = false
  for (const folder of new Set(folders)) {
    if (await exists(`${folder}/AGENTS.md`)) hasAgents = true
    for (const name of CLAUDE_FILES) {
      if (!(await exists(`${folder}/${name}`))) continue
      hasClaude = true
      const text = await $.fs.read(`${folder}/${name}`).catch(() => '')
      if (IMPORT.test(text)) isAgentsImported = true
    }
  }

  return { hasAgents, hasClaude, isAgentsImported }
}

/** Whether a project has written any rules down for agents. */
export const hasRules = (rules: Rules) => rules.hasAgents || rules.hasClaude

/**
 * What the agent is told of the project's rules at the head of each thread:
 * that AGENTS.md comes first, or, where there are no rules at all, that it
 * should suggest writing them. Nothing where only a CLAUDE.md speaks, since
 * Claude Code reads that by itself.
 */
export function rulesBrief(rules: Rules, isInitOn: boolean): string | undefined {
  if (rules.hasAgents) {
    const unread = rules.hasClaude && !rules.isAgentsImported
      ? ' Claude Code does not load AGENTS.md here by itself, because a CLAUDE.md is present: read AGENTS.md now, before anything else.'
      : ''

    return `# Project rules

This project keeps its rules in \`AGENTS.md\`, for any agent that works in it. Read it before you start on a task, unless it is already among your instructions, and read the files it points to, such as the skills in \`skills/\`, whenever the task is one they cover. Its rules come first: where a working mode or anything else the Agent Stage tells you differs from them, follow AGENTS.md and say so.${unread}`
  }
  if (rules.hasClaude || isInitOn) return undefined

  return `# No project rules yet

This folder has no AGENTS.md or CLAUDE.md: nothing tells agents how work is done here. Before you start on the person's first task, suggest in one sentence that they set the project up with \`/stage agent init\`, which asks what the project is for and writes an AGENTS.md and a \`skills/\` folder that any agent can read, whatever assistant it is. Suggest it once; if the person declines or goes on with their task, do the task.`
}

/** What the person is told once, when a session starts where no rules are written down. */
export const NO_RULES_NOTICE = 'No AGENTS.md here: /stage agent init sets the project up for any agent.'
