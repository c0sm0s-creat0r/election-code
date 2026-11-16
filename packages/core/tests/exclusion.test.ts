import { describe, it, expect } from 'vitest'
import { bulkExclusionSet } from '../src/exclusion.js'
import { fromInt } from '../src/fixed.js'

const t = (o: Record<string, number>) =>
  Object.entries(o).map(([id, v]) => ({ id, votes: fromInt(v) }))

describe('bulkExclusionSet', () => {
  it('excludes only the lowest when bulk would be unsafe', () => {
    // a=5, b=6, c=7: 5+6=11 > 7, so b cannot join a
    expect(bulkExclusionSet(t({ a: 5, b: 6, c: 7 }), 2)).toEqual(['a'])
  })

  it('excludes several when their combined total is below the next candidate', () => {
    // a=1, b=2, c=10: 1+2=3 < 10, so both a and b are safe to exclude
    expect(bulkExclusionSet(t({ a: 1, b: 2, c: 10 }), 2).sort()).toEqual(['a', 'b'])
  })

  it('never excludes so many that fewer candidates remain than seats', () => {
    // maxExcludable caps it even when the arithmetic would allow more
    expect(bulkExclusionSet(t({ a: 1, b: 1, c: 1, d: 30 }), 1)).toHaveLength(1)
  })

  it('excludes all tied-lowest together when safe', () => {
    // the case irv.py gets wrong: a=5, b=5, c=30. 5+5=10 < 30, safe.
    expect(bulkExclusionSet(t({ a: 5, b: 5, c: 30 }), 2).sort()).toEqual(['a', 'b'])
  })

  it('does NOT bulk-exclude tied candidates when unsafe', () => {
    // a=5, b=5, c=8: 5+5=10 > 8, so only one may go. This is the irv.py bug.
    expect(bulkExclusionSet(t({ a: 5, b: 5, c: 8 }), 2)).toHaveLength(1)
  })
})
