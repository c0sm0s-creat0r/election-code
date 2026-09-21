/**
 * Door check-in and quorum. The `door` role reaches these four routes and
 * nothing else — no elections, no candidates, no tally of any kind (spec §4).
 *
 * **Why the roll is fetched whole.** ~1,300 rows at roughly 40 bytes is ~50 KB.
 * The door app fetches it once and filters client-side on every keystroke, so
 * search is instant and keeps working if venue wifi drops mid-queue. A server
 * round-trip per keystroke is the wrong shape for a queue of 1,300 people.
 *
 * **Nothing here may reach `audit_log.detail`.** A check-in event is about one
 * named person, so the obvious `detail: { usu_id }` would leave identifiers in
 * the one table the post-AGM purge cannot touch — breaking spec §2's claim
 * that `voter_roll` and `check_in` are all the personal data held. The action
 * name and the batch are recorded; who, deliberately, is not.
 */
import { Hono } from 'hono'
import { z } from 'zod'
import { auditLogStatement } from '../db/audit.js'
import { requireRole, requireSession, type AuthedEnv } from '../middleware/requireRole.js'
import { rateLimit, RATE_LIMITS } from '../middleware/rateLimit.js'
import type { VoterRollRow } from '../db/types.js'
import { pathParam } from '../http/params.js'

const checkInSchema = z.object({ usu_id: z.string().min(1).max(32) })

type RollEntry = Pick<VoterRollRow, 'usu_id' | 'first_name' | 'last_name' | 'eligible'> & {
  checked_in_at: number | null
}

export const checkIn = new Hono<AuthedEnv>()

/**
 * Spec §6 names "roll lookup" as one of three surfaces that must be limited.
 * It is authenticated, but a 50 KB response is the largest thing a door tablet
 * can ask for in a loop.
 */
checkIn.get(
  '/api/batches/:id/roll',
  requireRole('door'),
  rateLimit(RATE_LIMITS.voting),
  async (c) => {
    const batchId = requireSession(c).batchId
    const { results } = await c.env.DB
      .prepare(
        `SELECT vr.usu_id, vr.first_name, vr.last_name, vr.eligible, ci.checked_in_at
           FROM voter_roll vr
           LEFT JOIN check_in ci ON ci.batch_id = vr.batch_id AND ci.usu_id = vr.usu_id
          WHERE vr.batch_id = ?
          ORDER BY vr.last_name, vr.first_name`,
      )
      .bind(batchId)
      .all<RollEntry>()
    return c.json(results)
  },
)

checkIn.post('/api/batches/:id/check-in', requireRole('door'), async (c) => {
  const batchId = requireSession(c).batchId
  const parsed = checkInSchema.safeParse(await c.req.json().catch(() => undefined))
  if (!parsed.success) return c.json({ error: 'invalid request body' }, 400)
  const usuId = parsed.data.usu_id

  // The roll check is folded INTO the insert rather than run before it. A
  // separate SELECT would be a read-then-write: the same shape as the legacy
  // `attendee.voted` race, where two tablets both read "eligible" and both
  // proceed. Here the database decides, once.
  const result = await c.env.DB
    .prepare(
      `INSERT INTO check_in (batch_id, usu_id, checked_in_at)
       SELECT ?1, ?2, ?3
        WHERE EXISTS (
          SELECT 1 FROM voter_roll
           WHERE batch_id = ?1 AND usu_id = ?2 AND eligible = 1
        )
       ON CONFLICT(batch_id, usu_id) DO NOTHING`,
    )
    .bind(batchId, usuId, Date.now())
    .run()

  if (result.meta.changes === 0) {
    // Zero rows means one of three things, and a volunteer at the door needs
    // to be told which: an unknown id is a typo, an ineligible member is a
    // membership question, and an already-checked-in member is simply done.
    const row = await c.env.DB
      .prepare(`SELECT eligible FROM voter_roll WHERE batch_id = ? AND usu_id = ?`)
      .bind(batchId, usuId)
      .first<Pick<VoterRollRow, 'eligible'>>()
    if (!row) return c.json({ error: 'not on the roll', code: 'not_on_roll' }, 404)
    if (row.eligible === 0) return c.json({ error: 'not an eligible member', code: 'ineligible' }, 403)
    return c.json({ checked_in: true, already: true })
  }

  await c.env.DB.batch([auditLogStatement(c.env.DB, { batchId, role: 'door', action: 'check_in.add' })])
  return c.json({ checked_in: true, already: false })
})

/**
 * Un-check-in. Idempotent: 204 whether or not a row was there, because the
 * door's intent ("this person is not here") is satisfied either way.
 *
 * This route is why a voter's session cookie can never be treated as proof of
 * eligibility — see routes/ballots.ts. An officer may un-check someone in
 * *after* their cookie was issued, and the cookie stays valid for its full TTL.
 */
checkIn.delete('/api/batches/:id/check-in/:usuId', requireRole('door'), async (c) => {
  const batchId = requireSession(c).batchId
  const usuId = pathParam(c, 'usuId')

  const result = await c.env.DB
    .prepare(`DELETE FROM check_in WHERE batch_id = ? AND usu_id = ?`)
    .bind(batchId, usuId)
    .run()

  if (result.meta.changes > 0) {
    await c.env.DB.batch([auditLogStatement(c.env.DB, { batchId, role: 'door', action: 'check_in.remove' })])
  }
  return c.body(null, 204)
})

checkIn.get('/api/batches/:id/quorum', requireRole('door'), async (c) => {
  const batchId = requireSession(c).batchId

  // Two counts, one round trip. `checked_in` counts only rows that still join
  // to an eligible roll member, so a member marked ineligible by a re-import
  // stops counting toward quorum without anyone having to remember to
  // un-check them in.
  const row = await c.env.DB
    .prepare(
      `SELECT
         (SELECT count(*) FROM voter_roll WHERE batch_id = ?1 AND eligible = 1) AS eligible,
         (SELECT count(*) FROM check_in ci
            JOIN voter_roll vr ON vr.batch_id = ci.batch_id AND vr.usu_id = ci.usu_id
           WHERE ci.batch_id = ?1 AND vr.eligible = 1) AS checked_in,
         (SELECT count(*) FROM guest WHERE batch_id = ?1) AS guests`,
    )
    .bind(batchId)
    .first<{ eligible: number; checked_in: number; guests: number }>()

  // `guests` is reported beside the ratio and never summed into it: spec §4
  // defines quorum as checked_in / eligible against the roll, and a guest is
  // not an eligible member.
  return c.json({
    checked_in: row?.checked_in ?? 0,
    eligible: row?.eligible ?? 0,
    guests: row?.guests ?? 0,
  })
})
