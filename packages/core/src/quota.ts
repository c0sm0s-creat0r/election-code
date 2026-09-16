import { type Fixed, fromInt } from './fixed.js'

/**
 * Droop quota, as the Australian Senate uses:
 *   floor(valid ballots / (seats + 1)) + 1
 *
 * Computed once from the initial valid total and never recomputed, so
 * exhausted ballots can leave the final seat filled below quota. That is
 * standard, and handled by the "continuing == remaining seats" rule.
 *
 * At seats = 1 this is floor(n/2) + 1, i.e. an absolute majority - which is
 * why instant-runoff needs no separate implementation.
 */
export function droopQuota(validBallots: number, seats: number): Fixed {
  if (!Number.isInteger(seats) || seats < 1) {
    throw new Error(`droopQuota: seats must be a positive integer, got ${seats}`)
  }
  if (!Number.isInteger(validBallots) || validBallots < 0) {
    throw new Error(`droopQuota: ballots must be a non-negative integer, got ${validBallots}`)
  }
  return fromInt(Math.floor(validBallots / (seats + 1)) + 1)
}
