import type { EngineInterface } from 'claude-code'

/** Reads `docker inspect --format '{{.Name}} {{.Image}}'`: container to image id. */
export function parseInspect(stdout: string): Record<string, string> {
  const images: Record<string, string> = {}
  for (const line of stdout.split('\n')) {
    // A container's line starts with its name, `/name`; anything else is docker
    // saying what it could not find.
    const [name, image] = line.trim().split(/\s+/)
    if (name?.startsWith('/') && image !== undefined) images[name.slice(1)] = image
  }

  return images
}

/**
 * Which image each named container runs now. A container that does not exist
 * is left out; a machine without docker answers null, and nothing is guessed.
 */
export async function inspectImages(
  $: EngineInterface,
  containers: readonly string[],
): Promise<Record<string, string> | null> {
  const names = containers.filter(c => /^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(c))
  if (names.length === 0) return {}
  try {
    const ran = await $.process.run(
      ['docker', 'inspect', '--format', '{{.Name}} {{.Image}}', ...names],
      { timeoutMs: 8000 },
    )
    const images = parseInspect(ran.stdout)

    return ran.exitCode !== 0 && Object.keys(images).length === 0 ? null : images
  } catch {
    return null
  }
}
