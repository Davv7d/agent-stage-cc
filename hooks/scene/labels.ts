import type { AgentState, ProbeStatus, ProbeWork } from '../../types'

export type Lang = 'en' | 'pl'

type Words = {
  coordinator: string
  work: string
  pr: string
  coordinatorName: string
  allGood: string
  waiting: (n: number) => string
  asleep: string
  worktrees: (n: number) => string
  questions: string
  since: string
  branch: string
  last: string
  more: (n: number) => string
  /** The worktree's folder, in a card that heads with the session's title. */
  worktree: string
  /** Heads a card's list of the subagents at work. */
  subagents: (n: number) => string
  /** What a subagent does now; `starting` before its first call. */
  doing: Record<ProbeWork | 'starting', string>
  queue: string
  free: string
  restoring: string
  urgent: string
  stale: string
  failedTests: string
  week: string
  agents: string
  planAgent: string
  mode: string
  planTodo: string
  planActive: string
  planDone: string
  gate: string
  step: (n: number, total: number) => string
  stepsDone: (done: number, total: number) => string
  planCounts: (done: number, active: number, left: number) => string
  scene: string
  hide: string
  notice: {
    question: (agent: string) => string
    urgent: (agent: string) => string
    failed: (agent: string) => string
    pr: (agent: string) => string
    released: (resource: string, by: string) => string
  }
  state: Record<AgentState, string>
  short: Record<AgentState, string>
  research: ResearchWords
}

/** What the research scene says. */
type ResearchWords = {
  /** What runs now and what was found: searches and probes in flight, sources in all. */
  counter: (searches: number, probes: number, sources: number, isFull: boolean) => string
  sources: string
  noSources: string
  concurrency: string
  peak: (n: number) => string
  probe: Record<ProbeStatus, string>
  /** Under a probe on the orbit: what it runs now, or how it ended. */
  probeShort: (status: ProbeStatus, inFlight: number) => string
  /** For a probe in a card or a list: that, and its calls in all. */
  probeLine: (status: ProbeStatus, inFlight: number, calls: number) => string
  summary: (running: number, done: number, stopped: number, failed: number, calls: number) => string
  /** A subagent known only by its calls. */
  unnamed: string
  tile: (domain: string, hits: number, isRead: boolean) => string
}

/**
 * The form of a Polish noun after a number: one, a few (2 to 4, but not 12
 * to 14), or many.
 */
export function plPlural(n: number, one: string, few: string, many: string): string {
  const units = n % 10
  const tens = n % 100
  if (n === 1) return one

  return units >= 2 && units <= 4 && (tens < 12 || tens > 14) ? few : many
}

const enPlural = (n: number, one: string, many: string) => (n === 1 ? one : many)

export const WORDS: Record<Lang, Words> = {
  en: {
    coordinator: 'COORDINATOR',
    work: 'WORK',
    pr: 'PR',
    coordinatorName: 'coordinator',
    allGood: 'all running on their own',
    waiting: n => `waiting for you: ${n}`,
    asleep: 'asleep',
    worktrees: n => `${n} worktree${n === 1 ? '' : 's'}`,
    questions: 'questions',
    since: 'since',
    branch: 'branch',
    last: 'last action',
    more: n => `+${n} more`,
    worktree: 'worktree',
    subagents: n => `${n} ${enPlural(n, 'subagent', 'subagents')} at work`,
    doing: { research: 'reading', coding: 'coding', testing: 'testing', starting: 'starting' },
    queue: 'queue',
    free: 'free',
    restoring: 'restoring',
    urgent: 'urgent: blocks the queue',
    stale: 'quiet for a long time',
    failedTests: 'failed tests',
    week: 'week',
    agents: 'agents',
    planAgent: 'AGENT',
    mode: 'mode',
    planTodo: 'PLAN',
    planActive: 'IN PROGRESS',
    planDone: 'DONE',
    gate: 'waiting for you',
    step: (n, total) => `step ${n} / ${total}`,
    stepsDone: (done, total) => `${done} / ${total} done`,
    planCounts: (done, active, left) => `done ${done} · in progress ${active} · left ${left}`,
    scene: 'stage',
    hide: 'hide',
    notice: {
      question: agent => `${agent} has a question for you`,
      urgent: agent => `${agent} has a question and is blocking the queue`,
      failed: agent => `${agent}: tests failed`,
      pr: agent => `${agent} opened a pull request`,
      released: (resource, by) => `${resource} is free (released by ${by})`,
    },
    state: {
      idle: 'idle', research: 'research', coding: 'coding', queue: 'in queue',
      testing: 'testing', failed: 'tests failed', question: 'question for you',
      pr: 'PR open', done: 'merged',
    },
    short: {
      idle: 'idle', research: 'research', coding: 'coding', queue: 'queue',
      testing: 'tests', failed: 'failed', question: 'questions', pr: 'PR', done: 'merged',
    },
    research: {
      counter: (searches, probes, sources, isFull) =>
        `in flight: ${searches} ${enPlural(searches, 'search', 'searches')} · ${probes} ${enPlural(probes, 'probe', 'probes')} · ${sources}${isFull ? '+' : ''} ${enPlural(isFull ? 2 : sources, 'source', 'sources')}`,
      sources: 'SOURCES',
      noSources: 'no sources yet',
      concurrency: 'IN FLIGHT · LAST 10 MIN',
      peak: n => `peak ${n}`,
      probe: { running: 'searching', done: 'done', stopped: 'stopped', failed: 'failed' },
      probeShort: (status, inFlight) => (status === 'running' ? `${inFlight} in flight` : WORDS.en.research.probe[status]),
      probeLine: (status, inFlight, calls) =>
        `${WORDS.en.research.probeShort(status, inFlight)} · ${calls} ${enPlural(calls, 'call', 'calls')}`,
      summary: (running, done, stopped, failed, calls) =>
        `probes: running ${running} · done ${done}${stopped > 0 ? ` · stopped ${stopped}` : ''}${failed > 0 ? ` · failed ${failed}` : ''} · calls ${calls}`,
      unnamed: 'subagent',
      tile: (domain, hits, isRead) => `${domain} · ${isRead ? 'read' : 'found'} · ${hits}×`,
    },
  },
  pl: {
    coordinator: 'NADZORCA',
    work: 'PRACA',
    pr: 'PR',
    coordinatorName: 'koordynator',
    allGood: 'wszystko idzie samo',
    waiting: n => `czeka na Ciebie: ${n}`,
    asleep: 'uśpiony',
    worktrees: n => `${n} worktree`,
    questions: 'pytania',
    since: 'od',
    branch: 'gałąź',
    last: 'ostatnio',
    more: n => `+${n} więcej`,
    worktree: 'worktree',
    subagents: n => `${n} ${plPlural(n, 'subagent pracuje', 'subagenty pracują', 'subagentów pracuje')}`,
    doing: { research: 'czyta', coding: 'koduje', testing: 'testuje', starting: 'startuje' },
    queue: 'kolejka',
    free: 'wolny',
    restoring: 'przywracanie',
    urgent: 'pilne: blokuje kolejkę',
    stale: 'długo bez ruchu',
    failedTests: 'nieudane testy',
    week: 'week',
    agents: 'agenci',
    planAgent: 'AGENT',
    mode: 'tryb',
    planTodo: 'PLAN',
    planActive: 'W TOKU',
    planDone: 'GOTOWE',
    gate: 'czeka na Ciebie',
    step: (n, total) => `krok ${n} / ${total}`,
    stepsDone: (done, total) => `${done} / ${total} gotowe`,
    planCounts: (done, active, left) => `zrobione ${done} · w toku ${active} · zostało ${left}`,
    scene: 'scena',
    hide: 'ukryj',
    notice: {
      question: agent => `${agent} ma do Ciebie pytanie`,
      urgent: agent => `${agent} ma pytanie i blokuje kolejkę`,
      failed: agent => `${agent}: testy nie przeszły`,
      pr: agent => `${agent} otworzył PR`,
      released: (resource, by) => `${resource} jest wolny (zwolnił ${by})`,
    },
    state: {
      idle: 'bezczynny', research: 'research', coding: 'kod', queue: 'kolejka',
      testing: 'testy', failed: 'testy nie przeszły', question: 'pytanie do Ciebie',
      pr: 'PR otwarty', done: 'zmergowany',
    },
    short: {
      idle: 'bezczynni', research: 'research', coding: 'kod', queue: 'kolejka',
      testing: 'testy', failed: 'błędy', question: 'pytania', pr: 'PR', done: 'zmergowane',
    },
    research: {
      counter: (searches, probes, sources, isFull) =>
        `w toku: ${searches} ${plPlural(searches, 'wyszukiwanie', 'wyszukiwania', 'wyszukiwań')} · ${probes} ${plPlural(probes, 'sonda', 'sondy', 'sond')} · ${sources}${isFull ? '+' : ''} ${plPlural(isFull ? 5 : sources, 'źródło', 'źródła', 'źródeł')}`,
      sources: 'ŹRÓDŁA',
      noSources: 'jeszcze brak źródeł',
      concurrency: 'W TOKU · OSTATNIE 10 MIN',
      peak: n => `szczyt ${n}`,
      probe: { running: 'szuka', done: 'gotowa', stopped: 'przerwana', failed: 'błąd' },
      probeShort: (status, inFlight) => (status === 'running' ? `${inFlight} w toku` : WORDS.pl.research.probe[status]),
      probeLine: (status, inFlight, calls) =>
        `${WORDS.pl.research.probeShort(status, inFlight)} · ${calls} ${plPlural(calls, 'wywołanie', 'wywołania', 'wywołań')}`,
      summary: (running, done, stopped, failed, calls) =>
        `sondy: w toku ${running} · gotowe ${done}${stopped > 0 ? ` · przerwane ${stopped}` : ''}${failed > 0 ? ` · błędy ${failed}` : ''} · wywołania ${calls}`,
      unnamed: 'subagent',
      tile: (domain, hits, isRead) => `${domain} · ${isRead ? 'przeczytane' : 'znalezione'} · ${hits}×`,
    },
  },
}

/**
 * Whether a locale names a language at all: `C` and `POSIX` are the absence
 * of one, common where a script or a container set them.
 */
export const namesLanguage = (locale: string | undefined): locale is string =>
  locale !== undefined && locale.trim() !== '' && !/^(c|posix)([._@-]|$)/i.test(locale.trim())

/**
 * The language from what a machine says of itself, in the order given: the
 * first source that names a language decides, so an empty or `C` setting
 * does not hide a real one further down.
 */
export const langFrom = (sources: readonly (string | undefined)[]): Lang => langOf(sources.find(namesLanguage)?.trim())

/** The preferred language macOS keeps: the first of `defaults read -g AppleLanguages`. */
export const appleLanguage = (stdout: string): string | undefined => /"?([A-Za-z]{2,3}(?:[-_][A-Za-z0-9]+)*)"?/.exec(stdout.replace(/[()]/g, ''))?.[1]

export const langOf = (locale: string | undefined): Lang =>
  locale !== undefined && /^pl([_.@-]|$)/i.test(locale) ? 'pl' : 'en'
