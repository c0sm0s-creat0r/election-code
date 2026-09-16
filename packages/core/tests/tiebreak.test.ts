import { describe, it, expect } from 'vitest'
import { countback, seededDraw, deriveSeed } from '../src/tiebreak.js'
import { fromInt } from '../src/fixed.js'
import type { Fixed } from '../src/fixed.js'

const r = (o: Record<string, number>): Map<string, Fixed> =>
  new Map(Object.entries(o).map(([k, v]) => [k, fromInt(v)]))

describe('countback', () => {
  it('excludes whoever was lower at the last round they differed', () => {
    const history = [r({ a: 10, b: 12 }), r({ a: 15, b: 15 })]
    // for an exclusion, the LOWER candidate at the differing round loses
    expect(countback(['a', 'b'], history, 'exclusion')).toEqual({ winner: 'a', atRound: 1 })
  })

  it('elects whoever was higher at the last round they differed', () => {
    const history = [r({ a: 10, b: 12 }), r({ a: 15, b: 15 })]
    expect(countback(['a', 'b'], history, 'election_order')).toEqual({ winner: 'b', atRound: 1 })
  })

  it('walks backwards and uses the MOST RECENT differing round', () => {
    const history = [r({ a: 1, b: 9 }), r({ a: 8, b: 5 }), r({ a: 15, b: 15 })]
    // round 2 is the most recent difference: a=8 > b=5, so b is excluded
    expect(countback(['a', 'b'], history, 'exclusion')).toEqual({ winner: 'b', atRound: 2 })
  })

  it('returns null when level at every round', () => {
    const history = [r({ a: 5, b: 5 }), r({ a: 9, b: 9 })]
    expect(countback(['a', 'b'], history, 'exclusion')).toBeNull()
  })
})

describe('seededDraw', () => {
  it('is deterministic for the same seed and tie id', async () => {
    const seed = await deriveSeed('election-1', 'abc123', 'tb-1')
    const a = await seededDraw(['x', 'y', 'z'], seed, 'tb-1')
    const b = await seededDraw(['x', 'y', 'z'], seed, 'tb-1')
    expect(a).toBe(b)
  })

  it('is independent of the order the tied candidates are passed in', async () => {
    const seed = await deriveSeed('election-1', 'abc123', 'tb-1')
    const a = await seededDraw(['x', 'y', 'z'], seed, 'tb-1')
    const b = await seededDraw(['z', 'y', 'x'], seed, 'tb-1')
    expect(a).toBe(b) // sorted internally, so caller order cannot steer it
  })

  it('always returns one of the tied candidates', async () => {
    for (const id of ['tb-1', 'tb-2', 'tb-3', 'tb-4', 'tb-5']) {
      const seed = await deriveSeed('e', 'deadbeef', id)
      expect(['x', 'y', 'z']).toContain(await seededDraw(['x', 'y', 'z'], seed, id))
    }
  })
})

describe('deriveSeed', () => {
  it('differs per tie-break id', async () => {
    // if it did not, two ties in one count would resolve to the same index
    const s1 = await deriveSeed('e1', 'hash', 'tb-1')
    const s2 = await deriveSeed('e1', 'hash', 'tb-2')
    expect(s1).not.toBe(s2)
  })

  it('differs when the ballot hash differs', async () => {
    const s1 = await deriveSeed('e1', 'hashA', 'tb-1')
    const s2 = await deriveSeed('e1', 'hashB', 'tb-1')
    expect(s1).not.toBe(s2)
  })

  it('is reproducible, so anyone can verify a draw after the fact', async () => {
    expect(await deriveSeed('e1', 'hash', 'tb-1')).toBe(await deriveSeed('e1', 'hash', 'tb-1'))
  })
})
