/**
 * Closing an election and sealing the box.
 *
 * Closing is irreversible. There is no reopen route: an officer who could
 * reopen could watch the result and choose when to stop.
 *
 * The status flip and the seal are two statements. The ballot insert requires
 * `status = 'open'`, so flipping first makes the ballots safe to read for the
 * digest. A Worker dying in between leaves the election closed but unsealed.
 * Calling this route again seals it without re-closing.
 */
import { Hono } from 'hono'
import { auditLogStatement } from '../db/audit.js'
import { requireRole, requireSession, type AuthedEnv } from '../middleware/requireRole.js'
import { ballotsSha256, type SealableBallot } from '../lib/seal.js'
import type { ElectionRow } from '../db/types.js'

export const close = new Hono<AuthedEnv>()

close.post('/api/batches/:id/elections/:eid/close', requireRole('officer'), async (c) => {
  const batchId = requireSession(c).batchId
  const electionId = c.req.param('eid')

  const election = await c.env.DB
    .prepare(`SELECT id, status, closed_at FROM election WHERE id = ? AND batch_id = ?`)
    .bind(electionId, batchId)
    .first<Pick<ElectionRow, 'id' | 'status' | 'closed_at'>>()
  if (!election) return c.json({ error: 'not found' }, 404)
  if (election.status === 'draft') {
    return c.json({ error: 'an election that never opened cannot be closed', code: 'not_open' }, 409)
  }

  if (election.status === 'closed') {
    // Closed and sealed: a second close. Closed and unsealed: a retry.
    const seal = await c.env.DB
      .prepare(`SELECT election_id FROM election_seal WHERE election_id = ?`)
      .bind(electionId)
      .first<{ election_id: string }>()
    if (seal) {
      return c.json({ error: 'this election is already closed and sealed', code: 'already_closed' }, 409)
    }
  }

  const closedAt = Date.now()

  if (election.status === 'open') {
    const flipped = await c.env.DB
      .prepare(`UPDATE election SET status = 'closed', closed_at = ?1 WHERE id = ?2 AND batch_id = ?3 AND status = 'open'`)
      .bind(closedAt, electionId, batchId)
      .run()
    if (flipped.meta.changes === 0) {
      // Someone else closed it between the read above and here.
      return c.json({ error: 'this election is already closed', code: 'already_closed' }, 409)
    }
  }

  // The digest is defined as sorted by id (spec §2).
  const { results: ballots } = await c.env.DB
    .prepare(`SELECT id, preferences, voided FROM ballot WHERE election_id = ? ORDER BY id`)
    .bind(electionId)
    .all<SealableBallot>()

  const digest = await ballotsSha256(ballots)
  // On a retry, keep the original `closed_at`: when voting stopped.
  const sealedAt = election.closed_at ?? closedAt

  await c.env.DB.batch([
    // DO NOTHING, so a retry cannot overwrite a seal another attempt wrote.
    c.env.DB
      .prepare(
        `INSERT INTO election_seal (election_id, closed_at, ballot_count, ballots_sha256)
         VALUES (?,?,?,?) ON CONFLICT(election_id) DO NOTHING`,
      )
      .bind(electionId, sealedAt, ballots.length, digest),
    // While set, `live_receipt_hash` joins a usu_id to a ballot's preferences.
    // Nothing can be voided after close, so clear it with the seal
    // (LIMITATIONS.md §7).
    c.env.DB
      .prepare(`UPDATE vote_receipt SET live_receipt_hash = NULL WHERE election_id = ?`)
      .bind(electionId),
    auditLogStatement(c.env.DB, {
      batchId,
      role: 'officer',
      action: 'election.close',
      detail: { kind: 'election_close', ballotCount: ballots.length },
    }),
  ])

  return c.json({ closed_at: sealedAt, ballot_count: ballots.length, ballots_sha256: digest })
})
