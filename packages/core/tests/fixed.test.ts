import { describe, it, expect } from 'vitest'
import { SCALE, ZERO, fromInt, format } from '../src/fixed.js'

describe('fixed-point', () => {
  it('scales integers by 100000', () => {
    expect(fromInt(1)).toBe(100_000n)
    expect(fromInt(0)).toBe(ZERO)
    expect(SCALE).toBe(100_000n)
  })

  it('formats to exactly five decimal places', () => {
    expect(format(fromInt(1))).toBe('1.00000')
    expect(format(0n)).toBe('0.00000')
    expect(format(133_333n)).toBe('1.33333')
    expect(format(50n)).toBe('0.00050')
  })

  it('throws on negative format', () => {
    expect(() => format(-50n)).toThrow(/negative/)
    expect(() => format(-133_333n)).toThrow(/negative/)
  })




})
