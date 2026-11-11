import type { EngineInterface } from 'claude-code'

import type { AgentRecord, ResourceRecord } from '../../types'
import { isAgentRecord, mend } from './model'
import { isResourceRecord } from './resource'

/** How long a merged agent's file is kept, so a view can fade it out. */
export const DONE_KEPT_MS = 60_000

export const agentsDir = (stateDir: string) => `${stateDir}/agents`

export const agentFile = (stateDir: string, id: string) => `${agentsDir(stateDir)}/${id}.json`

export async function load(
  $: EngineInterface,
  stateDir: string,
  id: string,
): Promise<AgentRecord | undefined> {
  try {
    const parsed: unknown = JSON.parse(await $.fs.read(agentFile(stateDir, id)))

    return isAgentRecord(parsed) ? mend(parsed) : undefined
  } catch {
    return undefined
  }
}

export async function loadAll($: EngineInterface, stateDir: string): Promise<AgentRecord[]> {
  const entries = await $.fs.list(agentsDir(stateDir)).catch(() => [])
  const names = entries
    .filter(e => e.kind === 'file' && e.name.endsWith('.json'))
    .map(e => e.name.slice(0, -'.json'.length))
  const records = await Promise.all(names.map(id => load($, stateDir, id)))

  return records.filter(r => r !== undefined)
}

/**
 * Writes a file whole or not at all: to a temporary file beside it, then
 * renamed over it, so a reader in another session never sees half.
 */
async function writeWhole($: EngineInterface, file: string, token: string, value: unknown): Promise<void> {
  const temp = `${file}.${token.replace(/[^A-Za-z0-9_-]/g, '')}.tmp`
  await $.fs.write(temp, `${JSON.stringify(value, null, 1)}\n`)
  const moved = await $.process.run(['mv', '-f', temp, file], { timeoutMs: 5000 })
  if (moved.exitCode !== 0) throw new Error(`agent-stage-cc: could not write ${file}`)
}

export async function save($: EngineInterface, stateDir: string, rec: AgentRecord): Promise<void> {
  await writeWhole($, agentFile(stateDir, rec.id), rec.sessionId, rec)
}

export const resourcesDir = (stateDir: string) => `${stateDir}/resources`

export const resourceFile = (stateDir: string, name: string) => `${resourcesDir(stateDir)}/${name}.json`

export async function loadResources($: EngineInterface, stateDir: string): Promise<ResourceRecord[]> {
  const entries = await $.fs.list(resourcesDir(stateDir)).catch(() => [])
  const found: ResourceRecord[] = []
  for (const entry of entries) {
    if (entry.kind !== 'file' || !entry.name.endsWith('.json')) continue
    try {
      const parsed: unknown = JSON.parse(await $.fs.read(`${resourcesDir(stateDir)}/${entry.name}`))
      if (isResourceRecord(parsed)) found.push(parsed)
    } catch {
      // A file caught mid-write or not ours is read again on the next poll.
    }
  }

  return found.sort((a, b) => (a.name < b.name ? -1 : 1))
}

export async function saveResource(
  $: EngineInterface,
  stateDir: string,
  rec: ResourceRecord,
  sessionId: string,
): Promise<void> {
  await writeWhole($, resourceFile(stateDir, rec.name), sessionId, rec)
}

/** Which files no longer stand for an agent: its worktree is gone, or it merged. */
export function isStale(rec: AgentRecord, worktreeExists: boolean, now: number): boolean {
  if (!worktreeExists) return true

  return rec.state === 'done' && now - rec.since > DONE_KEPT_MS
}

/** Removes stale files and answers the records that remain. */
export async function prune(
  $: EngineInterface,
  stateDir: string,
  records: readonly AgentRecord[],
  now: number,
): Promise<AgentRecord[]> {
  const kept: AgentRecord[] = []
  for (const rec of records) {
    const exists = await $.fs.exists(rec.worktree).catch(() => true)
    if (isStale(rec, exists, now)) {
      await $.process.run(['rm', '-f', agentFile(stateDir, rec.id)], { timeoutMs: 5000 }).catch(() => undefined)
    } else {
      kept.push(rec)
    }
  }

  return kept
}
