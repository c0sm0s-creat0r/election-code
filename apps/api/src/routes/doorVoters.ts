/**
 * Adding a member the export missed: the door creates their roll row and
 * checks them in.
 *
 * So a door password can enrol a voter (LIMITATIONS.md §12). The control is
 * the `added_at_door` flag: `GET /quorum` reports it, both attendance exports
 * include it, and nothing clears it.
 */
import { Hono } from 'hono'
import { z } from 'zod'
import { auditLogStatement, recordAudit } from '../db/audit.js'
import { requireRole, requireSession, type AuthedEnv } from '../middleware/requireRole.js'
import { rateLimit } from '../middleware/rateLimit.js'
import type { VoterRollRow } from '../db/types.js'

const doorVoterSchema = z.object({
  // The Net Id is 7 digits. 8 is accepted because the legacy app accepted it.
  usu_id: z.string().regex(/^\d{7,8}$/, 'usu_id must be 7 or 8 digits'),
  first_name: z.string().trim().min(1).max(200),
  last_name: z.string().trim().min(1).max(200),
})

export const doorVoters = new Hono<AuthedEnv>()

doorVoters.post(
  '/api/batches/:id/voters',
  requireRole('door'),
  rateLimit('VOTING_LIMITER'),
  async (c) => {
    const batchId = requireSession(c).batchId
    const parsed = doorVoterSchema.safeParse(await c.req.json().catch(() => undefined))
    if (!parsed.success) {
      return c.json({ error: parsed.error.issues[0]?.message ?? 'invalid request body' }, 400)
    }
    const { usu_id: usuId, first_name: firstName, last_name: lastName } = parsed.data

    // A conditional insert, not an upsert: a second tablet cannot race it, and
    // an existing member's row is not changed.
    const inserted = await c.env.DB
      .prepare(
        `INSERT INTO voter_roll (batch_id, usu_id, first_name, last_name, eligible, added_at_door)
         SELECT ?1, ?2, ?3, ?4, 1, 1
          WHERE NOT EXISTS (SELECT 1 FROM voter_roll WHERE batch_id = ?1 AND usu_id = ?2)`,
      )
      .bind(batchId, usuId, firstName, lastName)
      .run()

    if (inserted.meta.changes === 0) {
      return c.json(
        {
          error: 'that USU id is already on the roll — search for them and check them in instead',
          code: 'already_on_roll',
        },
        409,
      )
    }

    await c.env.DB.batch([
      c.env.DB
        .prepare(
          `INSERT INTO check_in (batch_id, usu_id, checked_in_at)
           SELECT ?1, ?2, ?3
            WHERE EXISTS (
              SELECT 1 FROM voter_roll WHERE batch_id = ?1 AND usu_id = ?2 AND added_at_door = 1
            )
           ON CONFLICT(batch_id, usu_id) DO NOTHING`,
        )
        .bind(batchId, usuId, Date.now()),
      auditLogStatement(c.env.DB, { batchId, role: 'door', action: 'voter.add_at_door' }),
    ])

    return c.json({ usu_id: usuId, first_name: firstName, last_name: lastName }, 201)
  },
)

doorVoters.delete('/api/batches/:id/voters/:usuId', requireRole('door'), async (c) => {
  const batchId = requireSession(c).batchId
  const usuId = c.req.param('usuId')

  // Both refusals are in the WHERE clause, so a ballot cast in between is
  // caught.
  const guard = `
    added_at_door = 1
    AND NOT EXISTS (
      SELECT 1 FROM vote_receipt vr
        JOIN election e ON e.id = vr.election_id
       WHERE e.batch_id = ?1 AND vr.usu_id = ?2
    )`

  // check_in first. Do not rely on the cascade for ordering.
  const [, deleted] = await c.env.DB.batch([
    c.env.DB
      .prepare(`DELETE FROM check_in WHERE batch_id = ?1 AND usu_id = ?2
                 AND EXISTS (SELECT 1 FROM voter_roll WHERE batch_id = ?1 AND usu_id = ?2 AND ${guard})`)
      .bind(batchId, usuId),
    c.env.DB
      .prepare(`DELETE FROM voter_roll WHERE batch_id = ?1 AND usu_id = ?2 AND ${guard}`)
      .bind(batchId, usuId),
  ])

  if ((deleted?.meta.changes ?? 0) === 0) {
    // Nothing deleted: absent (idempotent 204), from the export, or already voted.
    const row = await c.env.DB
      .prepare(`SELECT added_at_door FROM voter_roll WHERE batch_id = ? AND usu_id = ?`)
      .bind(batchId, usuId)
      .first<Pick<VoterRollRow, 'added_at_door'>>()
    if (!row) return c.body(null, 204)
    if (row.added_at_door === 0) {
      return c.json(
        {
          error: 'this member came from the membership export and cannot be removed here',
          code: 'from_export',
        },
        409,
      )
    }
    return c.json(
      { error: 'this member has already cast a ballot and cannot be removed', code: 'already_voted' },
      409,
    )
  }

  await recordAudit(c.env.DB, { batchId, role: 'door', action: 'voter.remove_at_door' })
  return c.body(null, 204)
})
