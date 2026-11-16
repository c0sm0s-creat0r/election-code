import { describe, it, expect } from 'vitest'
import { validateBallot, minimumPreferences } from '../src/ballot.js'

const CANDIDATES = ['a', 'b', 'c', 'd']

describe('minimumPreferences', () => {
  it('is the seat count', () => {
    expect(minimumPreferences(3, 5)).toBe(3)
  })

  it('never exceeds the number of candidates', () => {
    // 5 seats but only 4 candidates: demanding 5 preferences is unsatisfiable
    expect(minimumPreferences(5, 4)).toBe(4)
  })
})

describe('validateBallot', () => {
  it('accepts a full ranking', () => {
    expect(validateBallot(['a', 'b', 'c', 'd'], CANDIDATES, 2)).toEqual({ ok: true })
  })

  it('accepts a partial ranking at or above the minimum', () => {
    expect(validateBallot(['a', 'b'], CANDIDATES, 2)).toEqual({ ok: true })
    expect(validateBallot(['a', 'b', 'c'], CANDIDATES, 2)).toEqual({ ok: true })
  })

  it('rejects fewer preferences than seats', () => {
    const r = validateBallot(['a'], CANDIDATES, 2)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/at least 2/)
  })

  it('rejects an empty ballot', () => {
    expect(validateBallot([], CANDIDATES, 1).ok).toBe(false)
  })

  it('rejects an unknown candidate', () => {
    const r = validateBallot(['a', 'zzz'], CANDIDATES, 2)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/unknown/i)
  })

  it('rejects a duplicated preference', () => {
    const r = validateBallot(['a', 'a'], CANDIDATES, 2)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/duplicate/i)
  })

  it('reports unknown before duplicate when a ballot has both', () => {
    const r = validateBallot(['a', 'a', 'zzz'], CANDIDATES, 1)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/unknown/i)
  })

  it('rejects more preferences than candidates', () => {
    expect(validateBallot(['a', 'b', 'c', 'd', 'a'], CANDIDATES, 2).ok).toBe(false)
  })

  it('never lets the minimum collapse to zero', () => {
    // the floor of 1: a ballot ranking nobody is never valid
    expect(minimumPreferences(0, 5)).toBe(1)
    expect(minimumPreferences(3, 0)).toBe(1)
    expect(validateBallot([], [], 1).ok).toBe(false)
    expect(validateBallot([], CANDIDATES, 0).ok).toBe(false)
  })
})
