/**
 * The seal: a count and a digest of the ballot box, fixed at close. Ballots
 * carry no timestamp, so the seal is what detects post-close stuffing.
 */

import { sha256Hex } from './hash.js'

export type SealableBallot = { id: string; preferences: string; voided: number }

/**
 * Spec §2: every ballot row for the election, sorted by `id` ascending, each
 * rendered `id|preferences|voided`, joined with newlines. Voided ballots are
 * included. The caller orders the rows with `ORDER BY id`.
 */
export const sealSerialisation = (rows: readonly SealableBallot[]): string =>
  rows.map((r) => `${r.id}|${r.preferences}|${r.voided}`).join('\n')

export const ballotsSha256 = (rows: readonly SealableBallot[]): Promise<string> =>
  sha256Hex(sealSerialisation(rows))
