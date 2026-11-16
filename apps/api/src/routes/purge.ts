/**
 * The post-AGM purge (spec §2). Deletes `voter_roll`, `check_in` and `guest`.
 * Keeps `ballot`, `election_seal` and `election_result`: they are anonymous
 * and are the audit record.
 *
 * `vote_receipt` is kept, with its `usu_id`: the mark-off shows that distinct
 * eligible members cast the ballots in the box (LIMITATIONS.md §4). Its
 * `live_receipt_hash` was cleared at close.
 *
 * Refused while any election is open or in draft: the ballot insert checks
 * `voter_roll`, so a mid-AGM purge would make every voter ineligible.
 */
import { Hono } from 'hono'
import { auditLogStatement } from '../db/audit.js'
import { requireRole, requireSession, type AuthedEnv } from '../middleware/requireRole.js'

export const purge = new Hono<AuthedEnv>()

purge.delete('/api/batches/:id/roll', requireRole('officer'), async (c) => {
  const batchId = requireSession(c).batchId

  const counts = await c.env.DB
    .prepare(
      `SELECT
         (SELECT count(*) FROM election WHERE batch_id = ?1 AND status != 'closed') AS unfinished,
         (SELECT count(*) FROM voter_roll WHERE batch_id = ?1) AS roll,
         (SELECT count(*) FROM check_in WHERE batch_id = ?1) AS checkins,
         (SELECT count(*) FROM guest WHERE batch_id = ?1) AS guests`,
    )
    .bind(batchId)
    .first<{ unfinished: number; roll: number; checkins: number; guests: number }>()

  const unfinished = counts?.unfinished ?? 0
  if (unfinished > 0) {
    return c.json(
      {
        error: `${unfinished} election(s) are still open or in draft; close them before purging the roll`,
        code: 'elections_unfinished',
        remaining: unfinished,
      },
      409,
    )
  }

  const roll = counts?.roll ?? 0
  const checkins = counts?.checkins ?? 0
  const guests = counts?.guests ?? 0

  // check_in first. Do not rely on the cascade for ordering.
  await c.env.DB.batch([
    c.env.DB.prepare(`DELETE FROM check_in WHERE batch_id = ?`).bind(batchId),
    c.env.DB.prepare(`DELETE FROM voter_roll WHERE batch_id = ?`).bind(batchId),
    // A guest's name is personal data too.
    c.env.DB.prepare(`DELETE FROM guest WHERE batch_id = ?`).bind(batchId),
    auditLogStatement(c.env.DB, {
      batchId,
      role: 'officer',
      action: 'roll.purge',
      detail: { kind: 'roll_purge', rowsDeleted: roll + checkins + guests },
    }),
  ])

  // Idempotent: a second call deletes nothing and reports zeros.
  return c.json({ voter_roll: roll, check_in: checkins, guest: guests })
})
