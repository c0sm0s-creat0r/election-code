/**
 * Ballot submission. The most careful route in the API.
 *
 * **A session cookie is not proof of eligibility.** A voter session proves only
 * that someone passed id + surname at some earlier moment. An officer can
 * un-check-in a voter *after* their cookie was issued, and the post-AGM roll
 * purge deletes rows while cookies stay valid for their full TTL. Eligibility
 * is therefore re-verified on every submission.
 *
 * **And that re-check is not a read-then-write.** A `SELECT` before the insert
 * reintroduces exactly the race spec §6 exists to fix in the legacy
 * `attendee.voted` flag, where two browser tabs both read "has not voted" and
 * both proceed. The check is folded into both inserts with `WHERE EXISTS`, so
 * the database decides once, inside one transaction.
 *
 * **The ballot row carries no voter reference and no timestamp.** `id` is a
 * random UUID in a `WITHOUT ROWID` table, so physical row order is UUID order
 * rather than insertion order, and with no `cast_at` there is no join key
 * against `vote_receipt.voted_at`. Post-close stuffing is caught by the seal,
 * not by per-ballot timestamps — that is what the seal is for.
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
  // The usu_id is NEVER in the body: spec §5 says it is carried by the session
  // cookie, so a caller cannot nominate whose ballot this is.
  preferences: z.array(z.string().min(1)).min(1).max(200),
})

/**
 * Both inserts carry the same eligibility clause, so they succeed together or
 * not at all: no ballot without a mark-off, and no mark-off without a ballot.
 */
const ELIGIBLE = `
  EXISTS (
    SELECT 1
      FROM voter_roll vr
      JOIN check_in ci ON ci.batch_id = vr.batch_id AND ci.usu_id = vr.usu_id
      JOIN election e  ON e.id = ?2 AND e.batch_id = vr.batch_id AND e.status = 'open'
     WHERE vr.batch_id = ?1 AND vr.usu_id = ?3 AND vr.eligible = 1
  )`

/**
 * One live ballot per voter per election. This is the double-vote guard, and
 * it is a guard rather than the `vote_receipt` primary key because after a void
 * the receipt row still exists and must be reusable — a plain INSERT would
 * refuse a legitimate recast.
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
    // requireRole('voter') has already narrowed the role, and the Session union
    // gives a voter session a `subject` that cannot be undefined.
    const usuId = session.subject
    if (usuId === undefined) return c.json({ error: 'forbidden' }, 403)

    const parsed = ballotSchema.safeParse(await c.req.json().catch(() => undefined))
    if (!parsed.success) return c.json({ error: 'invalid request body' }, 400)

    const election = await c.env.DB
      .prepare(`SELECT id, status, seats FROM election WHERE id = ? AND batch_id = ?`)
      .bind(electionId, batchId)
      .first<Pick<ElectionRow, 'id' | 'status' | 'seats'>>()
    if (!election) return c.json({ error: 'not found' }, 404)
    if (election.status !== 'open') {
      return c.json({ error: `voting is not open (election is ${election.status})`, code: 'not_open' }, 409)
    }

    const { results: candidates } = await c.env.DB
      .prepare(`SELECT id FROM candidate WHERE election_id = ? ORDER BY ordinal`)
      .bind(electionId)
      .all<Pick<CandidateRow, 'id'>>()

    // The same validation the voter's browser ran, run again here. Its reason
    // strings are written to be read by a voter mid-ballot, so they are
    // returned as-is.
    const check = validateBallot(parsed.data.preferences, candidates.map((x) => x.id), election.seats)
    if (!check.ok) return c.json({ error: check.reason, code: 'invalid_ballot' }, 400)

    // Minted once, hashed immediately, returned once, never stored. A voter who
    // loses it can no longer verify inclusion — which is the trade for a
    // receipt that cannot be used to prove how they voted.
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

    // ORDER MATTERS. The ballot insert runs first. Reversed, the receipt upsert
    // sets live_receipt_hash and the ballot's own NO_LIVE_BALLOT guard then
    // fails against the row it just wrote, refusing every first ballot.
    const ballotStmt = c.env.DB.prepare(
      `INSERT INTO ballot (id, election_id, preferences, receipt_hash, voided)
       SELECT ?5, ?2, ?6, ?7, 0 WHERE ${ELIGIBLE} AND ${NO_LIVE_BALLOT}`,
    ).bind(...params)

    // The mark-off on the roll: who voted, never what. DO UPDATE rather than a
    // bare INSERT because the row survives a void. recast_count is NOT touched
    // here — the void already counted it.
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
      // Both guards are equivalent, so this is the only failure shape. Read the
      // receipt row once to say which refusal it was; the write has already
      // happened or not, so this cannot race it.
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
      // Unreachable: the two statements carry equivalent guards inside one
      // transaction. If it ever fires, a ballot exists with no mark-off or a
      // mark-off with no ballot, and the count is no longer defensible — so it
      // is a 500 and a log line, never a success.
      throw new Error('ballot and receipt disagreed inside one transaction')
    }

    await recordAudit(c.env.DB, { batchId, role: 'voter', action: 'ballot.cast' })

    return c.json({ receipt_token: receiptToken }, 201)
  },
)
