/**
 * The seal: what was in the ballot box at the moment voting closed.
 *
 * Ballots carry no timestamp (spec §2), so post-close stuffing cannot be
 * detected per row. The seal is what detects it instead — a count and a digest
 * frozen at close, against which the exported ballots can be checked later.
 */

export type SealableBallot = { id: string; preferences: string; voided: number }

/**
 * Spec §2, verbatim: every ballot row for the election, sorted by `id`
 * ascending, each rendered `id|preferences|voided`, joined with newlines.
 *
 * **Voided ballots are included.** The seal covers what is in the box, and a
 * voided ballot is still in the box — excluding them would let a void change
 * the digest without changing the ballots.
 *
 * The caller supplies rows already ordered by an explicit `ORDER BY id`. Do not
 * rely on `ballot` being `WITHOUT ROWID` for that: physical order happens to be
 * UUID order today, and the definition of the digest must not depend on a
 * storage detail a later migration could change.
 */
export const sealSerialisation = (rows: readonly SealableBallot[]): string =>
  rows.map((r) => `${r.id}|${r.preferences}|${r.voided}`).join('\n')

export async function ballotsSha256(rows: readonly SealableBallot[]): Promise<string> {
  const bytes = new TextEncoder().encode(sealSerialisation(rows))
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}
