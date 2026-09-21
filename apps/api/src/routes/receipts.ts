/**
 * Receipts: confirm that a ballot is recorded, and void it while the election
 * is still open.
 *
 * **The receipt confirms inclusion and never displays preferences.** Australia
 * deliberately has no voter receipt: one that proves *how* you voted lets you
 * be paid or pressured for it, and society elections with factions are not
 * immune. Confirming that a ballot of yours is recorded keeps the "my vote
 * wasn't counted" dispute solvable while remaining useless to a coercer. So
 * this route returns a status and an election name — never a candidate id, a
 * candidate name, or anything derived from the preference list.
 *
 * **Both routes are public, and that is safe** because looking a ballot up by
 * `receipt_hash` reveals nothing about identity: the ballot row has no voter
 * reference. The token is a bearer capability over one ballot. Losing it means
 * someone else can void that ballot — which spec §5 accepts by making this
 * route public — but never that they can cast one, because the mark-off cleared
 * is always found *through* the hash and so is always the true owner's.
 */
import { Hono } from 'hono'
import { recordAudit } from '../db/audit.js'
import { rateLimit, RATE_LIMITS } from '../middleware/rateLimit.js'
import { pathParam } from '../http/params.js'
import { sha256Hex } from '../lib/hash.js'
import type { Env } from '../index.js'

export const receipts = new Hono<{ Bindings: Env }>()

receipts.get('/api/receipts/:token', rateLimit(RATE_LIMITS.voting), async (c) => {
  const hash = await sha256Hex(pathParam(c, 'token'))

  // `voided` and the election's name. Nothing joins to the preference list, and
  // nothing joins to vote_receipt — a receipt lookup must not be able to
  // discover who cast the ballot it describes.
  const row = await c.env.DB
    .prepare(
      `SELECT b.voided, e.name AS election_name
         FROM ballot b
         JOIN election e ON e.id = b.election_id
        WHERE b.receipt_hash = ?`,
    )
    .bind(hash)
    .first<{ voided: number; election_name: string }>()

  if (!row) return c.json({ error: 'not found' }, 404)

  return c.json({
    status: row.voided === 1 ? 'voided' : 'recorded',
    election_name: row.election_name,
  })
})

receipts.post('/api/receipts/:token/void', rateLimit(RATE_LIMITS.voting), async (c) => {
  const hash = await sha256Hex(pathParam(c, 'token'))
  const now = Date.now()

  // Read the owning batch up front so the audit row can be attributed to it.
  // This is not a read-then-write: the updates below carry their own
  // conditions, and nothing here is trusted as a precondition. The batch id is
  // loaded from our own tables via ballot -> election, never taken from the
  // request, which is what audit_log requires of a caller that has no session.
  const owner = await c.env.DB
    .prepare(
      `SELECT e.batch_id FROM ballot b JOIN election e ON e.id = b.election_id
        WHERE b.receipt_hash = ?`,
    )
    .bind(hash)
    .first<{ batch_id: string }>()
  if (!owner) return c.json({ error: 'not found' }, 404)

  // Two conditional updates in one transaction. Both carry the open-election
  // test, so an election closing concurrently cannot let a void through, and
  // neither can act without the other.
  const [ballotResult] = await c.env.DB.batch([
    // The row stays in the table. The seal is computed over every ballot
    // including voided ones, so removing it would break the digest.
    c.env.DB
      .prepare(
        `UPDATE ballot SET voided = 1
          WHERE receipt_hash = ?1 AND voided = 0
            AND (SELECT status FROM election WHERE id = ballot.election_id) = 'open'`,
      )
      .bind(hash),
    // `live_receipt_hash` IS the WHERE clause: it is the only thing connecting
    // this token to a voter, because `ballot` carries no voter reference. An
    // UPDATE, never a DELETE — deleting the receipt would let the voter cast
    // again *and* erase the record that they had voted at all, so the roll
    // would stop showing it.
    c.env.DB
      .prepare(
        `UPDATE vote_receipt
            SET live_receipt_hash = NULL, recast_count = recast_count + 1, voted_at = ?2
          WHERE live_receipt_hash = ?1
            AND (SELECT status FROM election WHERE id = vote_receipt.election_id) = 'open'`,
      )
      .bind(hash, now),
  ])

  if ((ballotResult?.meta.changes ?? 0) === 0) {
    // Distinguish "no such receipt" from "that ballot can no longer be voided".
    // A second void of the same token finds voided = 1 and a live_receipt_hash
    // already NULL, so both statements matched nothing — 409, idempotently
    // refused, with recast_count untouched.
    const row = await c.env.DB
      .prepare(
        `SELECT b.voided, e.status
           FROM ballot b JOIN election e ON e.id = b.election_id
          WHERE b.receipt_hash = ?`,
      )
      .bind(hash)
      .first<{ voided: number; status: string }>()
    if (!row) return c.json({ error: 'not found' }, 404)
    if (row.voided === 1) return c.json({ error: 'that ballot is already voided', code: 'already_voided' }, 409)
    return c.json({ error: `voting has closed (election is ${row.status})`, code: 'not_open' }, 409)
  }

  // Attributed to the batch that owns the ballot, so a void appears in that
  // batch's audit export: a run of them is something an officer needs to see.
  await recordAudit(c.env.DB, { batchId: owner.batch_id, role: 'voter', action: 'ballot.void' })

  return c.json({ status: 'voided' })
})
