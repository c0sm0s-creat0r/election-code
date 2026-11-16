import { describe, it, expect } from 'vitest'
import { bulkExclusionSet } from '../src/exclusion.js'
import { fromInt } from '../src/fixed.js'

const t = (o: Record<string, number>) =>
  Object.entries(o).map(([id, v]) => ({ id, votes: fromInt(v) }))

describe('bulkExclusionSet', () => {
  it.each([
    // 5+6=11 > 7, so b cannot join a
    ['only the lowest when bulk would be unsafe', { a: 5, b: 6, c: 7 }, ['a']],
    // 1+2=3 < 10
    ['several when their combined total is below the next', { a: 1, b: 2, c: 10 }, ['a', 'b']],
    // the case irv.py gets wrong: 5+5=10 < 30
    ['all tied-lowest together when safe', { a: 5, b: 5, c: 30 }, ['a', 'b']],
    // 5+5=10 > 8, so only one may go. This is the irv.py bug.
    ['one of a tied pair when unsafe', { a: 5, b: 5, c: 8 }, ['a']],
  ])('excludes %s', (_label, totals, expected) => {
    expect(bulkExclusionSet(t(totals), 2)).toEqual(expected)
  })

  it('never excludes so many that fewer candidates remain than seats', () => {
    // maxExcludable caps it even when the arithmetic would allow more
    expect(bulkExclusionSet(t({ a: 1, b: 1, c: 1, d: 30 }), 1)).toHaveLength(1)
  })
})
