/**
 * Closing an election, and sealing the box.
 *
 * **Closing is irreversible, and that is the point.** Spec §4: an officer who
 * can reopen an election can watch the result develop and choose when to stop,
 * which makes every other control decorative. There is no reopen route, and a
 * second close is refused.
 *
 * **Why the status flip and the seal are two statements.** The digest is
 * computed over the ballots, so it has to read them, and reading then writing
 * is a race while the election is still open. The transition to `closed` is
 * what makes the read safe: Plan 2b's ballot insert carries `AND e.status =
 * 'open'` inside its `EXISTS` clause, so once the status flips no further
 * ballot can be written. Flip first, then read and seal.
 *
 * That leaves a window in which an election is closed but unsealed — a Worker
 * that dies between the two statements. It is handled rather than hoped away:
 * calling this route on a closed election with no seal proceeds to seal it, so
 * the operation is retryable without permitting a re-close.
 */
import { Hono } from 'hono'
import { auditLogStatement } from '../db/audit.js'
import { requireRole, requireSession, type AuthedEnv } from '../middleware/requireRole.js'
import { pathParam } from '../http/params.js'
import { ballotsSha256, type SealableBallot } from '../lib/seal.js'
import type { ElectionRow } from '../db/types.js'

export const close = new Hono<AuthedEnv>()

close.post('/api/batches/:id/elections/:eid/close', requireRole('officer'), async (c) => {
  const batchId = requireSession(c).batchId
  const electionId = pathParam(c, 'eid')

  const election = await c.env.DB
    .prepare(`SELECT id, status, closed_at FROM election WHERE id = ? AND batch_id = ?`)
    .bind(electionId, batchId)
    .first<Pick<ElectionRow, 'id' | 'status' | 'closed_at'>>()
  if (!election) return c.json({ error: 'not found' }, 404)
  if (election.status === 'draft') {
    return c.json({ error: 'an election that never opened cannot be closed', code: 'not_open' }, 409)
  }

  if (election.status === 'closed') {
    // Already closed. Sealed too? Then this is a genuine second close.
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

  // Explicit ORDER BY id: spec §2 defines the digest as sorted by id ascending.
  // `ballot` is WITHOUT ROWID so physical order is already UUID order, which is
  // exactly why writing this out matters — the definition must not be inherited
  // from a storage detail.
  const { results: ballots } = await c.env.DB
    .prepare(`SELECT id, preferences, voided FROM ballot WHERE election_id = ? ORDER BY id`)
    .bind(electionId)
    .all<SealableBallot>()

  const digest = await ballotsSha256(ballots)
  // On the retry path the row already carries a `closed_at`; the seal records
  // when voting actually stopped, not when the retry happened.
  const sealedAt = election.closed_at ?? closedAt

  await c.env.DB.batch([
    // DO NOTHING, so a retry of a closed-but-unsealed election cannot overwrite
    // a seal that another attempt already wrote.
    c.env.DB
      .prepare(
        `INSERT INTO election_seal (election_id, closed_at, ballot_count, ballots_sha256)
         VALUES (?,?,?,?) ON CONFLICT(election_id) DO NOTHING`,
      )
      .bind(electionId, sealedAt, ballots.length, digest),
    // HANDOFF §2. `live_receipt_hash` exists so a void can find the mark-off to
    // clear, and while it is set it joins a usu_id to that ballot's
    // preferences. Nothing can be voided after close, so the link has no
    // remaining purpose: clearing it here, in the same transaction as the seal,
    // is what keeps that exposure bounded to the voting window.
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
