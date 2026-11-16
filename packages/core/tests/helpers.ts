import type { CountBallot, CountInput } from '../src/types.js'

/** `[[prefs, n], ...]` -> n ballots per preference list. */
export const ballots = (spec: [string[], number][]): CountBallot[] =>
  spec.flatMap(([prefs, n]) =>
    Array.from({ length: n }, (_, i) => ({ id: `${prefs.join('')}-${i}`, preferences: prefs })),
  )

/** One seat, three candidates, no ballots, unless overridden. */
export const input = (over: Partial<CountInput> = {}): CountInput => ({
  candidates: [
    { id: 'a', name: 'Alex' },
    { id: 'b', name: 'Bo' },
    { id: 'c', name: 'Cass' },
  ],
  ballots: [],
  seats: 1,
  electionId: 'e1',
  ballotsSha256: 'deadbeef00000000',
  ...over,
})
