/**
 * Receipts: confirm a ballot is recorded, and void it while the election is
 * open.
 *
 * A receipt confirms inclusion and never shows preferences, so it cannot
 * prove how someone voted. These routes return a status and an election name.
 *
 * Both are public. The token is a bearer capability over one ballot: its
 * holder can void that ballot (LIMITATIONS.md §15) but cannot cast one. The
 * mark-off is found through the hash and is always the owner's.
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

  // Joins neither the preference list nor vote_receipt: a lookup must not
  // reveal who cast the ballot.
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

  // For the audit row only, not a precondition. The batch id comes from our
  // tables, never the request.
  const owner = await c.env.DB
    .prepare(
      `SELECT e.batch_id FROM ballot b JOIN election e ON e.id = b.election_id
        WHERE b.receipt_hash = ?`,
    )
    .bind(hash)
    .first<{ batch_id: string }>()
  if (!owner) return c.json({ error: 'not found' }, 404)

  // Two conditional updates in one transaction. Both require the election to
  // be open, so a concurrent close blocks the void.
  const [ballotResult] = await c.env.DB.batch([
    // The row stays: the seal covers voided ballots.
    c.env.DB
      .prepare(
        `UPDATE ballot SET voided = 1
          WHERE receipt_hash = ?1 AND voided = 0
            AND (SELECT status FROM election WHERE id = ballot.election_id) = 'open'`,
      )
      .bind(hash),
    // `live_receipt_hash` is the only link from this token to a voter. UPDATE,
    // never DELETE: the record that they voted stays.
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
    // Nothing matched: no such receipt, already voided, or the election closed.
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

  await recordAudit(c.env.DB, { batchId: owner.batch_id, role: 'voter', action: 'ballot.void' })

  return c.json({ status: 'voided' })
})
