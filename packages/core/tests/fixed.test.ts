import { describe, it, expect } from 'vitest'
import { SCALE, ZERO, fromInt, mul, div, format } from '../src/fixed.js'

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

  it('divides with truncation, never rounding', () => {
    // 1 / 3 = 0.333333... truncates to 0.33333, NOT 0.33334
    expect(div(fromInt(1), fromInt(3))).toBe(33_333n)
    // 2 / 3 = 0.666666... truncates to 0.66666, NOT 0.66667
    expect(div(fromInt(2), fromInt(3))).toBe(66_666n)
  })

  it('multiplies with truncation', () => {
    expect(mul(fromInt(2), fromInt(3))).toBe(fromInt(6))
    // 0.33333 * 0.33333 = 0.1111088889 -> truncates to 0.11110
    expect(mul(33_333n, 33_333n)).toBe(11_110n)
  })

  it('division is reproducible and exact', () => {
    // Repeatedly halving gives the same result every time
    const value = fromInt(10)
    const half1 = div(value, fromInt(2))
    const half2 = div(half1, fromInt(2))
    const half3 = div(half2, fromInt(2))

    // Verify exact values match hand computation
    expect(half1).toBe(500_000n) // 10 / 2 = 5
    expect(half2).toBe(250_000n) // 5 / 2 = 2.5
    expect(half3).toBe(125_000n) // 2.5 / 2 = 1.25
  })

  it('divide-multiply round-trip truncates exactly', () => {
    // the whole reason this module exists: avoid accumulation of floating-point drift
    // Divide by 3, then multiply back by 3, should yield exact truncated result
    const one = fromInt(1)
    const third = div(one, fromInt(3))
    expect(third).toBe(33_333n) // 0.33333 truncated

    const backToOne = mul(third, fromInt(3))
    expect(backToOne).toBe(99_999n) // 0.33333 * 3 = 0.99999 truncated, not rounded to 1
  })
})
