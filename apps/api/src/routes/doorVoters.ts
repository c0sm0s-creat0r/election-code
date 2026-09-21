/**
 * Adding a member the membership export missed.
 *
 * Someone joined last week, the CSV is stale, and they are standing at the desk.
 * The door creates their roll row and checks them in, and they can then sign in
 * and vote like anyone else.
 *
 * **This is a real weakening of the integrity story, and the flag is what makes
 * it survivable.** A door password can now enrol a voter, so "eligibility
 * derives from the USU membership export" becomes "derives from the export, plus
 * N people the door staff added". N must never be hidden: `added_at_door` is
 * reported by `GET /quorum` beside the totals and carried as a column in both
 * attendance exports, so a committee reading the file sees which voters came
 * from the export and which did not.
 *
 * Three rules, each closing a specific way this could go wrong:
 *
 * 1. **The roll row and the check-in are one transaction.** The volunteer's
 *    intent is "this person is here and needs to vote"; a roll row with no
 *    check-in is a member who still cannot.
 * 2. **A `usu_id` already on the roll is refused, not upserted.** A mistyped id
 *    that happens to match a real member would otherwise overwrite that
 *    member's name with the typed one — silently, and in the table eligibility
 *    is judged from. The 409 tells the volunteer the right action instead:
 *    search for them and check them in.
 * 3. **Removal is refused once they have voted.** Deleting the roll row behind a
 *    ballot already in the box destroys the eligibility evidence for it, and no
 *    door volunteer should be able to do that by tapping undo. A member from the
 *    export cannot be removed here at all — that is the roll import's job.
 */
import { Hono } from 'hono'
import { z } from 'zod'
import { auditLogStatement, recordAudit } from '../db/audit.js'
import { requireRole, requireSession, type AuthedEnv } from '../middleware/requireRole.js'
import { rateLimit, RATE_LIMITS } from '../middleware/rateLimit.js'
import { pathParam } from '../http/params.js'
import type { VoterRollRow } from '../db/types.js'

const doorVoterSchema = z.object({
  // The USU "Net Id" is 7 digits; 8 is accepted because the legacy app did and
  // a volunteer reading a card should not be refused over a format guess.
  usu_id: z.string().regex(/^\d{7,8}$/, 'usu_id must be 7 or 8 digits'),
  first_name: z.string().trim().min(1).max(200),
  last_name: z.string().trim().min(1).max(200),
})

export const doorVoters = new Hono<AuthedEnv>()

doorVoters.post(
  '/api/batches/:id/voters',
  requireRole('door'),
  rateLimit(RATE_LIMITS.voting),
  async (c) => {
    const batchId = requireSession(c).batchId
    const parsed = doorVoterSchema.safeParse(await c.req.json().catch(() => undefined))
    if (!parsed.success) {
      return c.json({ error: parsed.error.issues[0]?.message ?? 'invalid request body' }, 400)
    }
    const { usu_id: usuId, first_name: firstName, last_name: lastName } = parsed.data

    // Conditional insert, so the "already on the roll" test cannot be raced by a
    // second tablet adding the same person at the same moment. Not an upsert:
    // see rule 2 above.
    const inserted = await c.env.DB
      .prepare(
        `INSERT INTO voter_roll (batch_id, usu_id, first_name, last_name, eligible, added_at_door)
         SELECT ?1, ?2, ?3, ?4, 1, 1
          WHERE NOT EXISTS (SELECT 1 FROM voter_roll WHERE batch_id = ?1 AND usu_id = ?2)`,
      )
      .bind(batchId, usuId, firstName, lastName)
      .run()

    if (inserted.meta.changes === 0) {
      // Return before writing anything else: an existing member's row must not
      // be touched, and no check-in should appear for a refused request.
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
  const usuId = pathParam(c, 'usuId')

  // Both refusals live in the WHERE clause, so a ballot cast between a check and
  // a delete cannot slip through the gap.
  const guard = `
    added_at_door = 1
    AND NOT EXISTS (
      SELECT 1 FROM vote_receipt vr
        JOIN election e ON e.id = vr.election_id
       WHERE e.batch_id = ?1 AND vr.usu_id = ?2
    )`

  // check_in first. It has a foreign key onto voter_roll and ON DELETE CASCADE
  // would handle it, but the cascade is the database's safety net rather than
  // something to lean on for ordering.
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
    // Nothing deleted: absent (idempotent 204), from the export, or they voted.
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
