/**
 * The post-AGM purge: delete the members' details, keep the defensible count.
 *
 * Spec §2's retention rule. `voter_roll` and `check_in` go; `ballot`,
 * `election_seal` and `election_result` stay, because they are anonymous and
 * they are the audit record. What is left is a fully checkable result and none
 * of the 1,302 members' personal details.
 *
 * **The seal is what makes this safe.** Deleting the roll does not weaken the
 * result, because the count was sealed against the ballots, not against the
 * roll — the exported ballots still hash to `ballots_sha256` afterwards, and a
 * test asserts the export is byte-identical across a purge.
 *
 * **`vote_receipt` is kept, and it holds a `usu_id`.** That is a deliberate
 * exception to "all the personal data goes", decided on 2026-09-21: the
 * mark-off is half the integrity story — it is what shows that 200 distinct
 * eligible members cast the 200 ballots in the box — and the attendance export
 * is built from it. Spec §2 names it rather than claiming otherwise. Its
 * `live_receipt_hash` is already NULL by then, cleared at close.
 *
 * **Refused while any election is open or in draft.** Purging mid-AGM would
 * make every remaining voter ineligible, because Plan 2b's ballot insert
 * re-checks `voter_roll` on every submission by design. This has to be a
 * deliberate end-of-event action.
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
  // A guest's name is personal data and `guest` is not reachable from any other
  // purge, so it goes in the same transaction. Leaving it behind would reinstate
  // exactly the false retention claim spec §2 had corrected.
  const guests = counts?.guests ?? 0

  // check_in first: its foreign key references voter_roll(batch_id, usu_id).
  // The delete order matters even with ON DELETE CASCADE, because the cascade
  // is the database's fallback and not something to lean on for ordering.
  await c.env.DB.batch([
    c.env.DB.prepare(`DELETE FROM check_in WHERE batch_id = ?`).bind(batchId),
    c.env.DB.prepare(`DELETE FROM voter_roll WHERE batch_id = ?`).bind(batchId),
    c.env.DB.prepare(`DELETE FROM guest WHERE batch_id = ?`).bind(batchId),
    auditLogStatement(c.env.DB, {
      batchId,
      role: 'officer',
      action: 'roll.purge',
      detail: { kind: 'roll_purge', rowsDeleted: roll + checkins + guests },
    }),
  ])

  // Idempotent: a second call deletes nothing and reports zeros, so a retry
  // after a dropped connection is safe.
  return c.json({ voter_roll: roll, check_in: checkins, guest: guests })
})
