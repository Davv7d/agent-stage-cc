// What an agent is doing, read off what it does: no agent reports its state.

export type ActionKind =
  | 'research'
  | 'coding'
  | 'test'
  | 'ask'
  | 'pr-create'
  | 'pr-merge'
  | 'coordinate'
  | 'other'

export type Action = { kind: ActionKind; label: string }

export type Patterns = {
  /** A shell command matching one of these runs tests. */
  test: readonly RegExp[]
  /** A tool whose name matches one of these hands work to another agent. */
  coordinate: readonly RegExp[]
}

export const DEFAULT_PATTERNS: Patterns = {
  test: [
    /\b(pytest|vitest|jest|mocha|phpunit|rspec|ctest|playwright test|cypress run)\b/,
    /\b(npm|pnpm|yarn|bun)\s+(run\s+)?(test|e2e)\b/,
    /\b(go|cargo|dotnet|swift|mix|deno)\s+test\b/,
    /\b(mvn|mvnw|gradle|gradlew)\b.*\b(test|verify|check)\b/,
    /\bmake\s+(test|check)\b/,
  ],
  coordinate: [/(^|__)start_session$/, /(^|__)send_message$/, /^SendMessage$/],
}

const READ_TOOLS = new Set([
  'Read',
  'Glob',
  'Grep',
  'LS',
  'WebFetch',
  'WebSearch',
  'NotebookRead',
  'ToolSearch',
])
const WRITE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])

const READ_COMMANDS = new Set([
  'ls', 'cat', 'head', 'tail', 'grep', 'rg', 'find', 'fd', 'wc', 'pwd', 'echo',
  'which', 'tree', 'stat', 'file', 'jq', 'diff', 'du', 'df', 'env', 'date',
])
const READ_SUBCOMMANDS: Record<string, readonly string[]> = {
  git: ['status', 'log', 'diff', 'show', 'branch', 'rev-parse', 'blame', 'ls-files', 'remote', 'fetch', 'worktree list'],
  gh: ['pr view', 'pr list', 'pr status', 'pr checks', 'pr diff', 'issue view', 'issue list', 'run view', 'run list', 'api', 'auth status'],
  docker: ['ps', 'logs', 'inspect', 'stats', 'images', 'compose ps', 'compose logs'],
}

const cut = (text: string, max = 60) =>
  text.length > max ? `${text.slice(0, max - 1)}…` : text

const baseName = (path: string) => path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? path

const text = (value: unknown) => (typeof value === 'string' ? value : '')

/**
 * A command as the shell runs it, without what it merely carries: the bodies
 * of here-documents and the insides of quoted strings. A commit message or a
 * file being written may mention `pytest` or `gh pr create`; neither ran it.
 */
export function bare(command: string): string {
  const lines = command.split('\n')
  const kept: string[] = []
  let until: string | undefined
  for (const line of lines) {
    if (until !== undefined) {
      if (line.trim() === until) until = undefined
      continue
    }
    kept.push(line)
    until = /<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/.exec(line)?.[2]
  }

  return kept.join('\n').replace(/'[^']*'/g, "''").replace(/"(?:[^"\\]|\\.)*"/g, '""')
}

const segments = (command: string) =>
  command.split(/&&|\|\||[;|\n]/).map(p => p.trim()).filter(p => p !== '')

function isReadOnlyShell(command: string): boolean {
  const parts = segments(command)
  if (parts.length === 0) return false

  return parts.every(part => {
    if (/(^|[^0-9&])>{1,2}(?!&)/.test(part)) return false
    const words = part.split(/\s+/)
    const head = words[0] ?? ''
    if (head === 'cd') return true
    if (READ_COMMANDS.has(head)) return true
    const subs = READ_SUBCOMMANDS[head]
    if (subs === undefined) return false
    const rest = words.slice(1).filter(w => !w.startsWith('-')).join(' ')

    return subs.some(s => rest === s || rest.startsWith(`${s} `))
  })
}

function classifyShell(command: string, patterns: Patterns): ActionKind {
  const ran = bare(command)
  // `gh` counts where it is the command, not where it is an argument.
  const runs = (verb: string) => segments(ran).some(p => new RegExp(`^gh\\s+pr\\s+${verb}\\b`).test(p))
  if (runs('create')) return 'pr-create'
  if (runs('merge')) return 'pr-merge'
  if (patterns.test.some(p => p.test(ran))) return 'test'

  return isReadOnlyShell(ran) ? 'research' : 'coding'
}

export function classify(
  tool: string,
  input: Readonly<Record<string, unknown>>,
  patterns: Patterns = DEFAULT_PATTERNS,
): Action {
  if (tool === 'Bash') {
    const command = text(input.command).trim()

    return { kind: classifyShell(command, patterns), label: cut(`$ ${command.replace(/\s+/g, ' ')}`) }
  }
  if (tool === 'AskUserQuestion') return { kind: 'ask', label: 'asked a question' }
  if (patterns.coordinate.some(p => p.test(tool))) {
    return { kind: 'coordinate', label: cut(text(input.title) || text(input.description) || tool) }
  }
  if (WRITE_TOOLS.has(tool)) {
    return { kind: 'coding', label: cut(`${tool} ${baseName(text(input.file_path) || text(input.notebook_path))}`) }
  }
  if (READ_TOOLS.has(tool)) {
    const what = text(input.file_path) ? baseName(text(input.file_path)) : text(input.pattern) || text(input.query) || text(input.url)

    return { kind: 'research', label: cut(`${tool} ${what}`.trim()) }
  }

  return { kind: 'other', label: cut(tool) }
}

/** Whether a turn's closing answer leaves a question with the person. */
export function endsWithQuestion(answer: string): boolean {
  const lines = answer.split('\n').map(l => l.trim()).filter(l => l !== '')
  const last = lines[lines.length - 1] ?? ''

  return /[?？][\s*_`"'”’)\]]*$/.test(last)
}

export function findPrUrl(output: string): string | undefined {
  return /https?:\/\/[^\s"'<>]+\/pull\/\d+/.exec(output)?.[0]
}
