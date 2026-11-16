import { describe, it, expect } from 'vitest'
import { fromInt, format } from '../src/fixed.js'

describe('fixed-point', () => {
  it.each([
    [fromInt(1), '1.00000'],
    [0n, '0.00000'],
    [133_333n, '1.33333'],
    [50n, '0.00050'],
  ])('formats %d to exactly five decimal places', (value, expected) => {
    expect(format(value)).toBe(expected)
  })
})
