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

  it('never accumulates drift across repeated division', () => {
    // the whole reason this module exists
    let acc = ZERO
    const third = div(fromInt(1), fromInt(3))
    for (let i = 0; i < 3; i++) acc += third
    expect(acc).toBe(99_999n) // exactly, forever - not 0.9999999998
  })
})
