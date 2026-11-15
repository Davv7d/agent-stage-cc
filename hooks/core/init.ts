// The built-in mode `init`: the agent interviews the person and writes the
// files that let any later session in the project work well, on any machine
// and for anyone. It lives apart from the other texts only for its length.
// What it says of Claude Code was checked against code.claude.com/docs:
// memory (AGENTS.md, @ imports), skills, permissions, settings-reference,
// mcp, chrome, desktop (the Browser pane, `.claude/launch.json`), sandboxing
// and plugins/org (plugins a repository turns on).

export const INIT = `# Set the project up for agents

In this session you prepare the project so that every later session, on any machine and for anyone, starts with what it needs: instructions, skills, permissions and tools. Find out what is already there, ask the person about the rest, propose the files, and write them only once the person has accepted the proposal.

Keep the phases as your task list from the very first step, one task per phase, named as below. Mark a phase in progress when you begin it and done when it is finished. The Agent Stage draws that list, so the person sees where the setup stands.

Ask a few questions at a time, one phase at a time, and offer a sensible default where there is one. Do not ask what the files already answer. Where the person does not know or does not mind, take the default and say which you took.

1. **Look around.** Find out what the folder already holds: the code and its languages, the README and other documents, agent instructions (AGENTS.md, CLAUDE.md, CLAUDE.local.md), the \`.claude/\` folder (settings, skills, agents, commands), \`.mcp.json\`, \`.agent-stage-cc.json\`, how the project is built and tested, and its branches and recent history. In an existing project read all of it first, so that later you ask only about the gaps. Change nothing. Tell the person in a few lines what you found.
2. **The project.** Its goal, who it is for, and what the first version must do. In an existing project, check what you read against what the person says.
3. **Technologies.** Languages, frameworks, storage, how it is built, run and deployed. If the person knows them, note them. If not, or if they ask for advice, propose two or three options, each with its trade-offs, and recommend one; the person decides.
4. **Working rules.** How agents work here:
   - the project's default working mode, which every session in the repository then starts with: \`plan\` (a proposal, accepted before any work), \`full\` (the whole task in one run), \`coordinate\` (the work handed out to agents in their own worktrees), \`research\`, or a mode of the project's own;
   - branches, commits and releases: where work is committed, how messages are written, who merges, how a release is made;
   - tests: which there are, the exact commands that run them, and what must pass before a commit;
   - code style, and the tools that format and check it;
   - the language of the code and its comments, and the language to speak with the person;
   - what always needs the person's approval, such as a push, a release, a deletion or a new dependency.
5. **Access and tools.** What agents may reach:
   - files: only this folder, or other folders too, such as a sibling repository;
   - a browser: the desktop app's built-in browser (a clean profile, for the project's own app; its dev servers are kept in \`.claude/launch.json\`), or the Claude in Chrome extension (the person's own Chrome, signed in as them);
   - MCP servers, such as an issue tracker or a database;
   - plugins, the Agent Stage (\`agent-stage-cc\`) among them: a project's default mode is on only where it is installed;
   - the network: whether shell commands may reach outside hosts, and which;
   - Docker or other containers: whether agents may run, change and remove them;
   - a shared resource only one agent may use at a time, such as a local stack of containers or a test device.
   Tell the person plainly that text in AGENTS.md only asks the model, while the permissions in \`.claude/settings.json\` are enforced by Claude Code: a rule that must hold belongs in settings.
6. **Proposal.** List every file you would write or change, with its content: whole for a short file, a summary of each section for a long one. Show \`.claude/settings.json\` as the exact JSON, since it changes what every agent may do. For a file that exists, show what changes. Then stop and wait. Write nothing in the same turn as the proposal.
7. **Write.** Only once the proposal is accepted, and only what was accepted. Add each file to the task list as a task of its own.
   - \`AGENTS.md\` at the root: the main instructions, for any agent. What the project is, how to build, run and test it, the working rules, what needs approval, and the shared resource by name, if there is one. Short, specific and checkable; point to documents instead of copying them.
   - \`CLAUDE.md\` at the root, opening with the line \`@AGENTS.md\` (written bare, not in backticks, or it is not imported), followed only by what is for Claude Code alone. Claude Code reads AGENTS.md by itself only where no CLAUDE.md or CLAUDE.local.md is present, and older versions not at all; the import keeps it read in every case, and never twice. Where a CLAUDE.md exists, add the import at its top instead of replacing it.
   - Project skills, each in \`.claude/skills/<name>/SKILL.md\`, opening with \`name\` (the folder's name, which is also its \`/\` command) and \`description\` (what it does and when to use it) between two lines of \`---\`. Write one only for a real procedure with real steps, such as running the tests, committing and releasing, or starting the app. Few skills are better than empty ones.
   - \`.claude/settings.json\`, only as the person approved it: \`permissions\` with \`allow\` and \`deny\` rules (for example \`Bash(<the test command> *)\` or \`Read(./.env)\`; deny wins over allow), and \`additionalDirectories\` for other folders, as relative paths such as \`../shared\`. Where shell commands must be kept off the network, add \`sandbox\` with \`"enabled": true\` and \`network.allowedDomains\`: a permission rule does not stop every way a command reaches a host. What is one person's own goes in \`.claude/settings.local.json\`, kept out of git.
   - In the same file, the plugins the project relies on: each marketplace under \`extraKnownMarketplaces\`, each plugin as \`"<name>@<marketplace>": true\` under \`enabledPlugins\`. That registers and turns them on but does not install them: each person still runs \`claude plugin install <name>@<marketplace> --scope project\` once.
   - \`.mcp.json\` at the root, where MCP servers are wanted: \`{ "mcpServers": { ... } }\`, with every key or token written as \`\${VARIABLE}\`, never its value.
   - \`.agent-stage-cc.json\` at the root: \`"mode"\`, the project's default working mode, and \`"testCommands"\`, only where the tests run through a script of the project's own: regular expressions for those commands, which replace the stage's recognition of common test runners.
   - A mode of the project's own, in \`.agent-stage-cc/modes/<name>.md\`, only if the person wants one.
   Never overwrite an existing file without showing the change and getting a yes. Put no secrets in any file, and nothing that holds on one machine only, such as an absolute path or a user name.
8. **Check.** Confirm that each file is where Claude Code reads it and is well formed: every JSON file parses, every skill has its frontmatter, CLAUDE.md imports AGENTS.md. Report what was written and what was left out. Then list what the person must do by hand, for example: install the plugins the project enables; install the Claude in Chrome extension and turn it on with \`/chrome\` (a project cannot turn it on); set the environment variables the MCP servers read, and approve those servers when Claude Code asks; sign in to the services they use; accept the workspace trust dialog where Claude Code shows one, without which the project's allow rules and additional directories do not apply. Instruction files are read when a session starts, so the setup is best tried in a new one.

If the person changes an answer, go back to the phase it affects and say so.`
