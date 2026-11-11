import { expect, test } from 'claude-code/testing'

import { bare, classify, endsWithQuestion, findPrUrl } from '../hooks/core/derive'

const kind = (tool: string, input: Record<string, unknown> = {}) => classify(tool, input).kind
const sh = (command: string) => kind('Bash', { command })

test('reading and searching is research, editing is coding', async () => {
  expect(kind('Read', { file_path: '/a/b.ts' })).toBe('research')
  expect(kind('Grep', { pattern: 'x' })).toBe('research')
  expect(kind('WebSearch', { query: 'x' })).toBe('research')
  expect(kind('Edit', { file_path: '/a/b.ts' })).toBe('coding')
  expect(kind('Write', { file_path: '/a/b.ts' })).toBe('coding')
  expect(kind('mcp__some__tool')).toBe('other')
})

test('shell commands are read by what they do', async () => {
  expect(sh('git status && git log --oneline | head -5')).toBe('research')
  expect(sh('cd src && ls -la')).toBe('research')
  expect(sh('gh pr view 12')).toBe('research')
  expect(sh('echo hi > out.txt')).toBe('coding')
  expect(sh('git commit -m "x"')).toBe('coding')
  expect(sh('npm install')).toBe('coding')
})

test('test runners, PR creation and merge are recognised', async () => {
  expect(sh('cd api && pytest -q')).toBe('test')
  expect(sh('npm run test -- --watch=false')).toBe('test')
  expect(sh('./gradlew :app:test')).toBe('test')
  expect(sh('go test ./...')).toBe('test')
  expect(sh('gh pr create --fill')).toBe('pr-create')
  expect(sh('gh pr merge 12 --squash')).toBe('pr-merge')
})

test('a project can bring its own test patterns', async () => {
  const mine = { test: [/\bcheck-all\.sh\b/], coordinate: [] }
  expect(classify('Bash', { command: './check-all.sh' }, mine).kind).toBe('test')
  expect(classify('Bash', { command: 'pytest' }, mine).kind).toBe('coding')
})

test('asking and handing out work are recognised by the tool', async () => {
  expect(kind('AskUserQuestion')).toBe('ask')
  expect(kind('mcp__ccd_session__start_session', { title: 'T1' })).toBe('coordinate')
  expect(kind('SendMessage')).toBe('coordinate')
})

test('labels are short and name the file, not its path', async () => {
  expect(classify('Edit', { file_path: '/very/long/path/file.ts' }).label).toBe('Edit file.ts')
  expect(classify('Bash', { command: 'x'.repeat(200) }).label.length).toBe(60)
})

test('a closing question is told from a closing statement', async () => {
  expect(endsWithQuestion('Done.\n\nShould I open the PR?')).toBe(true)
  expect(endsWithQuestion('Which one do you prefer?**\n')).toBe(true)
  expect(endsWithQuestion('Why? Because it failed.')).toBe(false)
  expect(endsWithQuestion('')).toBe(false)
})

test('a PR url is found in command output', async () => {
  expect(findPrUrl('Creating...\nhttps://github.com/o/r/pull/42\n')).toBe('https://github.com/o/r/pull/42')
  expect(findPrUrl('nothing')).toBe(undefined)
})

test('a command that only mentions a tool did not run it', async () => {
  expect(sh('git commit -m "fix the pytest config"')).toBe('coding')
  expect(sh("echo 'then run gh pr create'")).toBe('research')
  expect(sh("cat > notes.md <<'EOF'\ngh pr create --fill\nnpm test\nEOF")).toBe('coding')
  expect(sh('python3 - <<PY\nprint("gh pr merge 1")\nPY\ngit status')).toBe('coding')
  // What runs after a here-document still counts.
  expect(sh("cat > a.txt <<'EOF'\nhello\nEOF\nnpm test")).toBe('test')
  expect(sh('cd app && gh pr create --fill')).toBe('pr-create')
  expect(bare("a 'b c' \"d \\\" e\" f")).toBe('a \'\' "" f')
})
