import type { AgentState } from '../../types'

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
}

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
