/**
 * Door check-in and quorum. The `door` role reaches these routes only: no
 * election, candidate or tally.
 *
 * The roll (~1,300 rows, ~50 KB) is fetched whole. The door app filters it
 * client-side, so search works if venue wifi drops.
 */
import { Hono } from 'hono'
import { z } from 'zod'
import { recordAudit } from '../db/audit.js'
import { requireRole, requireSession, type AuthedEnv } from '../middleware/requireRole.js'
import { rateLimit, RATE_LIMITS } from '../middleware/rateLimit.js'
import type { VoterRollRow } from '../db/types.js'
import { pathParam } from '../http/params.js'

const checkInSchema = z.object({ usu_id: z.string().min(1).max(32) })

type RollEntry = Pick<VoterRollRow, 'usu_id' | 'first_name' | 'last_name' | 'eligible'> & {
  checked_in_at: number | null
}

export const checkIn = new Hono<AuthedEnv>()

/** Rate limited though authenticated: this is the largest response in the API. */
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

  // The roll check is in the insert, not a SELECT before it, so two tablets
  // cannot both read "eligible" and proceed.
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
    // Say which: a typo, a membership question, or already done.
    const row = await c.env.DB
      .prepare(`SELECT eligible FROM voter_roll WHERE batch_id = ? AND usu_id = ?`)
      .bind(batchId, usuId)
      .first<Pick<VoterRollRow, 'eligible'>>()
    if (!row) return c.json({ error: 'not on the roll', code: 'not_on_roll' }, 404)
    if (row.eligible === 0) return c.json({ error: 'not an eligible member', code: 'ineligible' }, 403)
    return c.json({ checked_in: true, already: true })
  }

  await recordAudit(c.env.DB, { batchId, role: 'door', action: 'check_in.add' })
  return c.json({ checked_in: true, already: false })
})

/**
 * Un-check-in. Idempotent: 204 whether or not a row existed.
 *
 * It can run after a voter's cookie was issued, which is why the cookie does
 * not prove eligibility (see ballots.ts).
 */
checkIn.delete('/api/batches/:id/check-in/:usuId', requireRole('door'), async (c) => {
  const batchId = requireSession(c).batchId
  const usuId = pathParam(c, 'usuId')

  const result = await c.env.DB
    .prepare(`DELETE FROM check_in WHERE batch_id = ? AND usu_id = ?`)
    .bind(batchId, usuId)
    .run()

  if (result.meta.changes > 0) {
    await recordAudit(c.env.DB, { batchId, role: 'door', action: 'check_in.remove' })
  }
  return c.body(null, 204)
})

checkIn.get('/api/batches/:id/quorum', requireRole('door'), async (c) => {
  const batchId = requireSession(c).batchId

  // `checked_in` counts only rows that still join to an eligible member. A
  // re-import marking someone ineligible removes them from quorum.
  const row = await c.env.DB
    .prepare(
      `SELECT
         (SELECT count(*) FROM voter_roll WHERE batch_id = ?1 AND eligible = 1) AS eligible,
         (SELECT count(*) FROM check_in ci
            JOIN voter_roll vr ON vr.batch_id = ci.batch_id AND vr.usu_id = ci.usu_id
           WHERE ci.batch_id = ?1 AND vr.eligible = 1) AS checked_in,
         (SELECT count(*) FROM guest WHERE batch_id = ?1) AS guests,
         (SELECT count(*) FROM voter_roll WHERE batch_id = ?1 AND added_at_door = 1) AS added_at_door`,
    )
    .bind(batchId)
    .first<{ eligible: number; checked_in: number; guests: number; added_at_door: number }>()

  // `guests` is reported beside the ratio, never added to it. `added_at_door`
  // is always returned with the totals.
  return c.json({
    checked_in: row?.checked_in ?? 0,
    eligible: row?.eligible ?? 0,
    guests: row?.guests ?? 0,
    added_at_door: row?.added_at_door ?? 0,
  })
})
