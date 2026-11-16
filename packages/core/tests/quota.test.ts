import { describe, it, expect } from 'vitest'
import { droopQuota } from '../src/quota.js'
import { format } from '../src/fixed.js'

describe('droop quota', () => {
  // floor(valid / (seats + 1)) + 1
  it.each([
    [100, 3, '26.00000'],
    [101, 3, '26.00000'],
    [103, 3, '26.00000'],
    [104, 3, '27.00000'],
    // seats = 1 is a simple majority, which is why IRV is not a separate code path
    [100, 1, '51.00000'],
    [101, 1, '51.00000'],
    [10, 1, '6.00000'],
  ])('%d ballots, %d seat(s) -> %s', (valid, seats, expected) => {
    expect(format(droopQuota(valid, seats))).toBe(expected)
  })

  it('rejects nonsense input', () => {
    expect(() => droopQuota(10, 0)).toThrow(/seats/)
    expect(() => droopQuota(-1, 1)).toThrow(/ballots/)
  })
})
