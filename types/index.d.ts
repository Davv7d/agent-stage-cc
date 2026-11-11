/**
 * The state names are a public contract: skins, config and other tools key on
 * them. Add names; never rename or repurpose one after a release.
 */
export type AgentState =
  | 'idle'
  | 'research'
  | 'coding'
  | 'queue'
  | 'testing'
  | 'failed'
  | 'question'
  | 'pr'
  | 'done'

export type AgentRole = 'agent' | 'coordinator'

export type PlanStepStatus = 'pending' | 'active' | 'done'

/** One step of an agent's plan, as read from the task list the agent keeps. */
export type PlanStep = {
  /** The list's own name for the step, where it gives one. */
  id?: string
  text: string
  status: PlanStepStatus
  /** When the step was done, ms since the epoch: tells the latest one. */
  doneAt?: number
}

/** One agent's file: `<git common dir>/agent-stage-cc/agents/<id>.json`. */
export type AgentRecord = {
  /** Schema version of this file. */
  v: 1
  /** Stable name of the agent: the worktree folder's name. */
  id: string
  /** Absolute path of the working tree the agent's session runs in. */
  worktree: string
  branch: string | null
  sessionId: string
  /** False once the session that wrote the file has ended. */
  isLive: boolean
  role: AgentRole
  state: AgentState
  /** When `state` was entered, ms since the epoch. */
  since: number
  /** The state a `question` returns to once it is answered. */
  before?: AgentState
  /** Short text of the last thing the agent did. */
  lastAction: string
  lastActionAt: number
  /** When the agent last received a prompt (an order or an answer). */
  promptAt: number
  updatedAt: number
  /** Present while the agent has a pull request open. */
  pr?: { url: string }
  /** The agent's plan, while it keeps a task list. */
  plan?: PlanStep[]
  /** The working mode the person turned on for the agent's session, by name. */
  mode?: string
  /** The coordinator's role came from the mode alone, and leaves with it. */
  isRoleFromMode?: true
}

/** A record as a view draws it: with what depends on the clock worked out. */
export type AgentView = AgentRecord & {
  /** Idle or ended, and quiet for longer than the configured threshold. */
  isAsleep: boolean
  /** Waiting on the person: a question, or failed tests. */
  needsAttention: boolean
}

/**
 * A shared resource only one agent should use at a time, such as a local
 * stack of containers: `<git common dir>/agent-stage-cc/resources/<name>.json`.
 * The mod records who holds it and who waits; it enforces nothing.
 */
export type ResourceRecord = {
  v: 1
  name: string
  /** The agent that holds the resource now, by id. */
  holder: string | null
  heldSince: number
  /** When it was last released. */
  releasedAt: number
  /** Agents waiting for it, first in line first. */
  queue: string[]
  /** The containers in scope, as the holder reported them. */
  members: string[]
  /** Each member's image when it came into scope, to tell a swap by. */
  baseline: Record<string, string>
  updatedAt: number
}

export type ResourcePhase = 'free' | 'held' | 'restoring'

/** A resource as a view draws it: with what the machine says worked out. */
export type ResourceView = ResourceRecord & {
  /** Members whose image is no longer the baseline's. */
  swapped: string[]
  /** `restoring`: nobody holds it, but swapped images are still in place. */
  phase: ResourcePhase
  /** The holder waits on the person while others wait on the holder. */
  isUrgent: boolean
  /** The holder has done nothing for longer than the configured threshold. */
  isStale: boolean
}

export type Snapshot = {
  agents: AgentView[]
  resources: ResourceView[]
  /** Ids of the agents acting as coordinator, if any. */
  coordinators: string[]
  counts: Record<AgentState, number>
}

/** What something costs the machine: CPU in percent of one core, memory in bytes. */
export type Usage = { cpu: number; ramBytes: number }

/** The machine as a whole: CPU as a percent of all its cores, memory in use. */
export type SystemUsage = { cpuPercent: number; ramBytes: number }

/** What a session that shows the stage last measured. */
export type UsageReport = {
  /** Everything that runs on the machine, as the system itself counts it. */
  system: SystemUsage
  /** By agent id: the processes whose working directory is in its worktree. */
  agents: Record<string, Usage>
  /** By container name: the containers in a shared resource's scope. */
  containers: Record<string, Usage>
  machine: { cores: number; ramBytes: number }
}

/**
 * Usage as the scene draws it: in a few coarse steps, so that a number
 * drifting by a little does not redraw the scene.
 */
export type UsageLevels = {
  /** By agent id. `cpu`: 0 quiet to 3 heavy. `ram`: 0 to 4 quarters of a bar. */
  agents: Record<string, { cpu: number; ram: number }>
  /** By container name: 0 quiet to 3 heavy. */
  containers: Record<string, number>
  /** The whole machine's CPU in use, percent of all cores, in tens. */
  cpuPercent: number
  ramGb: number
  /** The stage's own share of both: its agents and the containers in scope. */
  ownCpuPercent: number
  ownRamGb: number
  machineGb: number
  cores: number
}

/** What the scene draws of one agent. */
export type SceneAgent = {
  id: string
  state: AgentState
  isAsleep: boolean
  needsAttention: boolean
  branch: string | null
  lastAction: string
  since: number
  promptAt: number
  prUrl?: string
  /** What the agent cost the machine when the scene was last drawn. */
  usage?: Usage
  /** The agent's plan, while it keeps one. */
  plan?: PlanStep[]
  /** The working mode the agent's session is in, by name. */
  mode?: string
}

/** Which scene the pane shows: the team, one agent's plan, or whichever fits. */
export type ViewMode = 'auto' | 'team' | 'plan'

/** Where one step of a plan stands: its zone, and which place in it. */
export type StepPlace = { zone: 'todo' | 'active' | 'gate' | 'done'; index: number }

/** What the scene draws of one step. `ordinal` counts from one. */
export type SceneStep = { key: string; ordinal: number; text: string; status: PlanStepStatus }

/**
 * One agent's plan as a scene: its steps move from waiting, through in
 * progress, to done, as agents move between zones in the team's scene.
 */
export type PlanScene = {
  agent: SceneAgent
  steps: SceneStep[]
  places: Record<string, StepPlace>
  prevPlaces: Record<string, StepPlace>
  /** The agent stopped with steps left: the plan waits on the person. */
  isWaiting: boolean
  /** Steps with no place on show, by zone. */
  more: { todo: number; done: number }
}

/** Fixed places per zone, so an agent never jumps while it stays in a zone. */
export type Slots = { work: (string | null)[]; pr: (string | null)[] }

/** Where one agent stands: its zone, and which place in it. */
export type Place = { zone: 'work' | 'pr' | 'queue' | 'holder'; index: number }

/** White: an order or an answer to the agent. Pink: its question back. */
export type Spark = { agent: string; kind: 'order' | 'ask' }

/** What the scene draws of the shared resource. */
export type SceneResource = {
  name: string
  holder: string | null
  queue: string[]
  members: string[]
  swapped: string[]
  phase: ResourcePhase
  isUrgent: boolean
  isStale: boolean
}

/**
 * The scene's own state: who stands where now and where they stood before,
 * so a drawing can carry each agent from its old place to its new one.
 * It changes only when something a person would see changes.
 */
export type Stage = {
  key: string
  coordinator: SceneAgent | null
  agents: SceneAgent[]
  resource: SceneResource | null
  slots: Slots
  places: Record<string, Place>
  prevPlaces: Record<string, Place>
  sparks: Spark[]
  /** Present when the pane shows one agent's plan instead of the team. */
  plan: PlanScene | null
  /** The usage steps on show, and when they were last let change the scene. */
  levels: UsageLevels | null
  levelsAt: number
}

/** One of the account's rate-limit windows, as Claude Code reports it. */
export type Limit = {
  /** `five_hour`, `seven_day`, or a gateway's own window. */
  kind: string
  /** How much of the window is used, 0 to 100. */
  percentUsed: number
  /** When the window resets, ISO 8601. */
  resetsAt?: string
}

/** What the band above the prompt and the status line show. */
export type Brief = {
  /**
   * The whole machine's load, as the system counts it, and within it the
   * stage's own share: its agents and the containers in scope. Null until
   * measured.
   */
  usage: { cpuPercent: number; ramGb: number; machineGb: number; own: { cpuPercent: number; ramGb: number } } | null
  limits: Limit[]
  questions: number
  failed: number
}

/** The view switches of the scene. */
export type ViewToggles = { focus: boolean; labels: boolean; links: boolean }

declare module 'claude-code' {
  interface PluginState {
    'agent-stage-cc': {
      snapshot: Shaped<Snapshot>
      stage: Shaped<Stage | null>
      view: ViewToggles
      demo: boolean
      brief: Shaped<Brief | null>
      bandHidden: boolean
      /** The scene a person picked; null leaves it to the config. */
      viewMode: ViewMode | null
      /** The working mode turned on for the session, by name. */
      workMode: string | null
    }
  }
}
