import { describe, it, expect } from 'vitest'
import { validateBallot, minimumPreferences } from '../src/ballot.js'

const CANDIDATES = ['a', 'b', 'c', 'd']

describe('minimumPreferences', () => {
  it.each([
    ['is the seat count', 3, 5, 3],
    // 5 seats, 4 candidates: demanding 5 preferences is unsatisfiable
    ['never exceeds the number of candidates', 5, 4, 4],
    // a ballot ranking nobody is never valid
    ['never drops below 1 with no seats', 0, 5, 1],
    ['never drops below 1 with no candidates', 3, 0, 1],
  ])('%s', (_label, seats, candidateCount, expected) => {
    expect(minimumPreferences(seats, candidateCount)).toBe(expected)
  })
})

describe('validateBallot', () => {
  it.each([
    ['a full ranking', ['a', 'b', 'c', 'd']],
    ['a partial ranking at the minimum', ['a', 'b']],
    ['a partial ranking above the minimum', ['a', 'b', 'c']],
  ])('accepts %s', (_label, preferences) => {
    expect(validateBallot(preferences, CANDIDATES, 2)).toEqual({ ok: true })
  })

  it.each([
    ['fewer preferences than seats', ['a'], CANDIDATES, 2, /at least 2/],
    ['an empty ballot', [], CANDIDATES, 1, /at least 1/],
    ['an empty ballot with no candidates', [], [], 1, /at least 1/],
    ['an empty ballot with no seats', [], CANDIDATES, 0, /at least 1/],
    ['an unknown candidate', ['a', 'zzz'], CANDIDATES, 2, /unknown/i],
    ['a duplicated preference', ['a', 'a'], CANDIDATES, 2, /duplicate/i],
  ])('rejects %s', (_label, preferences, candidateIds, seats, reason) => {
    const r = validateBallot(preferences, candidateIds, seats)
    expect(r).toEqual({ ok: false, reason: expect.stringMatching(reason) })
  })
})
