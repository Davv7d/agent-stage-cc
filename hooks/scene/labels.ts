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
    waiting: n => `waiting on you: ${n}`,
    asleep: 'asleep',
    worktrees: n => `${n} worktree${n === 1 ? '' : 's'}`,
    questions: 'questions',
    since: 'since',
    branch: 'branch',
    last: 'last',
    more: n => `+${n} more`,
    queue: 'queue',
    free: 'free',
    restoring: 'restoring',
    urgent: 'urgent: blocks the queue',
    stale: 'quiet for a long time',
    failedTests: 'failed tests',
    week: 'week',
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

export const langOf = (locale: string | undefined): Lang =>
  locale !== undefined && /^pl([_.@-]|$)/i.test(locale) ? 'pl' : 'en'
