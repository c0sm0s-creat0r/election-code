import { type Fixed, fromInt } from './fixed.js'

/**
 * Droop quota: floor(valid ballots / (seats + 1)) + 1.
 *
 * Computed once. Exhausted ballots can leave the last seat filled below
 * quota. At seats = 1 it is an absolute majority, so instant-runoff needs no
 * separate code.
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
