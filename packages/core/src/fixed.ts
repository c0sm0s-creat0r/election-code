/**
 * Vote values in fixed point: 5 decimal places, truncated toward zero.
 *
 * Matches the Scottish STV rules. Chosen over arbitrary-precision rationals
 * deliberately: a published, fixed rule can be checked by hand on paper,
 * which is the point of the whole audit story. BigInt division truncates
 * toward zero natively. All values here are expected to be non-negative:
 * format() throws on a negative value, because a negative vote total is
 * nonsense and rendering one would put it in an audit document. div() does not
 * check signs - it guards only against a zero divisor - so a negative
 * numerator divides as BigInt does, truncating toward zero.
 */
export type Fixed = bigint

export const SCALE = 100_000n
export const ZERO: Fixed = 0n

export function fromInt(n: number): Fixed {
  return BigInt(n) * SCALE
}

export function mul(a: Fixed, b: Fixed): Fixed {
  return (a * b) / SCALE
}

export function div(a: Fixed, b: Fixed): Fixed {
  if (b === 0n) throw new Error('fixed: division by zero')
  return (a * SCALE) / b
}

export function format(f: Fixed): string {
  if (f < ZERO) throw new Error(`fixed: cannot format a negative value: ${f}`)
  const whole = f / SCALE
  const frac = (f % SCALE).toString().padStart(5, '0')
  return `${whole}.${frac}`
}
