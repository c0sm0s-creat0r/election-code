import { describe, it, expect } from 'vitest'
import { droopQuota } from '../src/quota.js'
import { format } from '../src/fixed.js'

describe('droop quota', () => {
  it('is floor(valid / (seats + 1)) + 1', () => {
    expect(format(droopQuota(100, 3))).toBe('26.00000') // floor(100/4)+1
    expect(format(droopQuota(101, 3))).toBe('26.00000') // floor(101/4)=25, +1
    expect(format(droopQuota(103, 3))).toBe('26.00000') // floor(103/4)=25, +1
    expect(format(droopQuota(104, 3))).toBe('27.00000') // floor(104/4)=26, +1
  })

  it('collapses to a simple majority at seats = 1', () => {
    // this is why IRV is not a separate code path
    expect(format(droopQuota(100, 1))).toBe('51.00000')
    expect(format(droopQuota(101, 1))).toBe('51.00000')
    expect(format(droopQuota(10, 1))).toBe('6.00000')
  })

  it('is always an exact integer', () => {
    for (const v of [7, 13, 99, 1302]) {
      for (const s of [1, 2, 3, 5]) {
        expect(droopQuota(v, s) % 100_000n).toBe(0n)
      }
    }
  })

  it('rejects nonsense input', () => {
    expect(() => droopQuota(10, 0)).toThrow(/seats/)
    expect(() => droopQuota(-1, 1)).toThrow(/ballots/)
  })
})
