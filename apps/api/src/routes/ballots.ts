/**
 * Ballot submission.
 *
 * A session cookie does not prove eligibility: a voter can be un-checked-in,
 * or the roll purged, while the cookie is valid. Both inserts re-check
 * eligibility with `WHERE EXISTS`, so there is no read-then-write race.
 *
 * The ballot row has no voter reference and no timestamp. Its table is
 * `WITHOUT ROWID` with a random id, so nothing joins it to `vote_receipt`.
 */
import { Hono } from 'hono'
import { z } from 'zod'
import { validateBallot } from '@election/core'
import { recordAudit } from '../db/audit.js'
import { requireRole, requireSession, type AuthedEnv } from '../middleware/requireRole.js'
import { rateLimit, RATE_LIMITS } from '../middleware/rateLimit.js'
import { pathParam } from '../http/params.js'
import { sha256Hex } from '../lib/hash.js'
import type { CandidateRow, ElectionRow } from '../db/types.js'

const ballotSchema = z.object({
  // No usu_id here. It comes from the session, so a caller cannot choose whose
  // ballot this is.
  preferences: z.array(z.string().min(1)).min(1).max(200),
})

/** On both inserts: never a ballot without a mark-off, or the reverse. */
const ELIGIBLE = `
  EXISTS (
    SELECT 1
      FROM voter_roll vr
      JOIN check_in ci ON ci.batch_id = vr.batch_id AND ci.usu_id = vr.usu_id
      JOIN election e  ON e.id = ?2 AND e.batch_id = vr.batch_id AND e.status = 'open'
     WHERE vr.batch_id = ?1 AND vr.usu_id = ?3 AND vr.eligible = 1
  )`

/**
 * One live ballot per voter per election. The `vote_receipt` primary key
 * cannot enforce it: the receipt row survives a void and must allow a recast.
 */
const NO_LIVE_BALLOT = `
  NOT EXISTS (
    SELECT 1 FROM vote_receipt
     WHERE election_id = ?2 AND usu_id = ?3 AND live_receipt_hash IS NOT NULL
  )`

export const ballots = new Hono<AuthedEnv>()

ballots.post(
  '/api/batches/:id/elections/:eid/ballots',
  requireRole('voter'),
  rateLimit(RATE_LIMITS.voting),
  async (c) => {
    const session = requireSession(c)
    const batchId = session.batchId
    const electionId = pathParam(c, 'eid')
    // A voter session always has a subject; this narrows the type.
    const usuId = session.subject
    if (usuId === undefined) return c.json({ error: 'forbidden' }, 403)

    const parsed = ballotSchema.safeParse(await c.req.json().catch(() => undefined))
    if (!parsed.success) return c.json({ error: 'invalid request body' }, 400)

    const [election, { results: candidates }] = await Promise.all([
      c.env.DB
        .prepare(`SELECT id, status, seats FROM election WHERE id = ? AND batch_id = ?`)
        .bind(electionId, batchId)
        .first<Pick<ElectionRow, 'id' | 'status' | 'seats'>>(),
      c.env.DB
        .prepare(`SELECT id FROM candidate WHERE election_id = ? ORDER BY ordinal`)
        .bind(electionId)
        .all<Pick<CandidateRow, 'id'>>(),
    ])
    if (!election) return c.json({ error: 'not found' }, 404)
    if (election.status !== 'open') {
      return c.json({ error: `voting is not open (election is ${election.status})`, code: 'not_open' }, 409)
    }

    // Same validation as the browser. Its reasons are written for a voter, so
    // return them as-is.
    const check = validateBallot(parsed.data.preferences, candidates.map((x) => x.id), election.seats)
    if (!check.ok) return c.json({ error: check.reason, code: 'invalid_ballot' }, 400)

    // Returned once, stored only as a hash. A lost token cannot be recovered.
    const receiptToken = crypto.randomUUID()
    const receiptHash = await sha256Hex(receiptToken)

    const params = [
      batchId,
      electionId,
      usuId,
      Date.now(),
      crypto.randomUUID(),
      JSON.stringify(parsed.data.preferences),
      receiptHash,
    ]

    // Ballot first. Reversed, the receipt upsert sets live_receipt_hash and
    // NO_LIVE_BALLOT refuses every first ballot.
    const ballotStmt = c.env.DB.prepare(
      `INSERT INTO ballot (id, election_id, preferences, receipt_hash, voided)
       SELECT ?5, ?2, ?6, ?7, 0 WHERE ${ELIGIBLE} AND ${NO_LIVE_BALLOT}`,
    ).bind(...params)

    // The mark-off: who voted, never what. An upsert, because the row survives a
    // void. recast_count is unchanged; the void already counted it.
    const receiptStmt = c.env.DB.prepare(
      `INSERT INTO vote_receipt (election_id, usu_id, voted_at, recast_count, live_receipt_hash)
       SELECT ?2, ?3, ?4, 0, ?7 WHERE ${ELIGIBLE}
       ON CONFLICT(election_id, usu_id) DO UPDATE
         SET voted_at = ?4, live_receipt_hash = ?7
         WHERE vote_receipt.live_receipt_hash IS NULL`,
    ).bind(...params)

    const [ballotResult, receiptResult] = await c.env.DB.batch([ballotStmt, receiptStmt])

    const wroteBallot = (ballotResult?.meta.changes ?? 0) > 0
    const wroteReceipt = (receiptResult?.meta.changes ?? 0) > 0

    if (!wroteBallot && !wroteReceipt) {
      // Read the receipt row to say which refusal it was. The write is done, so
      // this cannot race it.
      const receipt = await c.env.DB
        .prepare(`SELECT live_receipt_hash FROM vote_receipt WHERE election_id = ? AND usu_id = ?`)
        .bind(electionId, usuId)
        .first<{ live_receipt_hash: string | null }>()
      if (receipt && receipt.live_receipt_hash !== null) {
        return c.json({ error: 'a ballot has already been recorded for you', code: 'already_voted' }, 409)
      }
      return c.json({ error: 'not eligible to vote in this election', code: 'not_eligible' }, 403)
    }

    if (wroteBallot !== wroteReceipt) {
      // Unreachable while the two guards stay equivalent. A ballot without a
      // mark-off (or the reverse) breaks the count, so throw.
      throw new Error('ballot and receipt disagreed inside one transaction')
    }

    await recordAudit(c.env.DB, { batchId, role: 'voter', action: 'ballot.cast' })

    return c.json({ receipt_token: receiptToken }, 201)
  },
)
