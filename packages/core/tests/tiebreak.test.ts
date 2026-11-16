import { describe, it, expect } from 'vitest'
import { countback, seededDraw, deriveSeed } from '../src/tiebreak.js'
import { fromInt } from '../src/fixed.js'
import type { Fixed } from '../src/fixed.js'

const r = (o: Record<string, number>): Map<string, Fixed> =>
  new Map(Object.entries(o).map(([k, v]) => [k, fromInt(v)]))

describe('countback', () => {
  const lastRoundLevel = [r({ a: 10, b: 12 }), r({ a: 15, b: 15 })]

  it.each([
    ['excludes whoever was lower at the last round they differed',
      lastRoundLevel, 'exclusion', { winner: 'a', atRound: 1 }],
    ['elects whoever was higher at the last round they differed',
      lastRoundLevel, 'election_order', { winner: 'b', atRound: 1 }],
    // round 2 is the most recent difference: a=8 > b=5, so b is excluded
    ['uses the most recent differing round',
      [r({ a: 1, b: 9 }), r({ a: 8, b: 5 }), r({ a: 15, b: 15 })], 'exclusion', { winner: 'b', atRound: 2 }],
    ['returns null when level at every round',
      [r({ a: 5, b: 5 }), r({ a: 9, b: 9 })], 'exclusion', null],
    // only a and b are tied; c's totals must not count as a difference
    ['ignores candidates outside the tie',
      [r({ a: 1, b: 2, c: 9 }), r({ a: 5, b: 5, c: 8 })], 'exclusion', { winner: 'a', atRound: 1 }],
    ['returns null when the tied pair is level throughout, whatever others hold',
      [r({ a: 5, b: 5, c: 8 }), r({ a: 7, b: 7, c: 9 })], 'exclusion', null],
  ] as const)('%s', (_label, history, kind, expected) => {
    expect(countback(['a', 'b'], [...history], kind)).toEqual(expected)
  })
})

describe('deriveSeed and seededDraw', () => {
  it('give the known answer for fixed inputs', async () => {
    // sha256('election-1|abc123|tb-1'); first 8 bytes mod 3 = 1 -> 'y'
    const seed = await deriveSeed('election-1', 'abc123', 'tb-1')
    expect(seed).toBe('aee5b2775979da5b7608b311aabeb8a8bfd1c0727d06b195e3f6f76e0af2a328')
    expect(await seededDraw(['x', 'y', 'z'], seed)).toBe('y')
    // sorted internally, so caller order cannot steer it
    expect(await seededDraw(['z', 'y', 'x'], seed)).toBe('y')
  })

  it.each([
    // otherwise two ties in one count would resolve to the same index
    ['tie-break id', 'hash', 'tb-2'],
    ['ballot hash', 'hashB', 'tb-1'],
  ])('the seed differs when the %s differs', async (_label, hash, tieBreakId) => {
    expect(await deriveSeed('e1', hash, tieBreakId)).not.toBe(await deriveSeed('e1', 'hash', 'tb-1'))
  })
})
