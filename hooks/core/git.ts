import type { EngineInterface } from 'claude-code'

import type { Identity } from './model'

export const STATE_FOLDER = 'agent-stage-cc'

const trimSlash = (path: string) => (path.length > 1 ? path.replace(/[\\/]+$/, '') : path)

export const baseName = (path: string) => trimSlash(path).split(/[\\/]/).pop() ?? path

/** A worktree's folder name as a file-safe agent id. */
export function agentId(worktree: string): string {
  const name = baseName(worktree).replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '')

  return name === '' ? 'agent' : name.slice(0, 80)
}

/**
 * Reads `git rev-parse --path-format=absolute --git-common-dir --show-toplevel`
 * and `git branch --show-current`: who this working tree is, and where every
 * worktree of the repository shares state.
 */
export function parseIdentity(revParse: string, branch: string): Identity | undefined {
  const [common, top] = revParse.split('\n').map(l => l.trim()).filter(l => l !== '')
  if (common === undefined || top === undefined) return undefined
  const worktree = trimSlash(top)

  return {
    id: agentId(worktree),
    worktree,
    branch: branch.trim() === '' ? null : branch.trim(),
    stateDir: `${trimSlash(common)}/${STATE_FOLDER}`,
  }
}

export async function locate($: EngineInterface, cwd: string): Promise<Identity | undefined> {
  const rev = await $.process.run(
    ['git', 'rev-parse', '--path-format=absolute', '--git-common-dir', '--show-toplevel'],
    { cwd, timeoutMs: 5000 },
  )
  if (rev.exitCode !== 0) return undefined
  const branch = await $.process.run(['git', 'branch', '--show-current'], { cwd, timeoutMs: 5000 })

  return parseIdentity(rev.stdout, branch.exitCode === 0 ? branch.stdout : '')
}

export type PrState = { state: 'open' | 'merged' | 'closed'; url?: string }

/** Reads `gh pr view --json state,url`; undefined where it says nothing clear. */
export function parsePrView(exitCode: number, stdout: string, stderr: string): PrState | undefined {
  if (exitCode !== 0) {
    // No pull request for the branch: whatever was recorded is gone.
    return /no pull requests? found/i.test(stderr) ? { state: 'closed' } : undefined
  }
  try {
    const parsed = JSON.parse(stdout) as { state?: unknown; url?: unknown }
    const state = String(parsed.state).toLowerCase()
    if (state !== 'open' && state !== 'merged' && state !== 'closed') return undefined

    return typeof parsed.url === 'string' ? { state, url: parsed.url } : { state }
  } catch {
    return undefined
  }
}

/**
 * Asks the forge what became of an agent's pull request: by its address, or
 * for the branch of the working tree. Without `gh`, or signed out, undefined.
 */
export async function prState(
  $: EngineInterface,
  worktree: string,
  url: string | undefined,
): Promise<PrState | undefined> {
  try {
    const ran = await $.process.run(
      ['gh', 'pr', 'view', ...(url === undefined ? [] : [url]), '--json', 'state,url'],
      { cwd: worktree, timeoutMs: 15000 },
    )

    return parsePrView(ran.exitCode, ran.stdout, ran.stderr)
  } catch {
    return undefined
  }
}
