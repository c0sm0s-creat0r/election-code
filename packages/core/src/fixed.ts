/**
 * Vote values in fixed point: 5 decimal places, truncated toward zero.
 * A fixed rule can be checked by hand.
 */
export type Fixed = bigint

export const SCALE = 100_000n
export const ZERO: Fixed = 0n

export function fromInt(n: number): Fixed {
  return BigInt(n) * SCALE
}

export function format(f: Fixed): string {
  if (f < ZERO) throw new Error(`fixed: cannot format a negative value: ${f}`)
  const whole = f / SCALE
  const frac = (f % SCALE).toString().padStart(5, '0')
  return `${whole}.${frac}`
}
