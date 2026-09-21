/**
 * Turnout while voting is open — and nothing else.
 *
 * Spec §4 gives the officer exactly one thing during `open`: "see turnout
 * only". Withholding the tally until close is the central control (an officer
 * who can watch the result develop chooses when to stop), and turnout is what
 * makes that bearable: it is how they know whether the queue has cleared and
 * whether it is time to close.
 *
 * **So this must never grow a per-candidate figure.** Three integers, asserted
 * by key equality in the tests at both `open` and `closed`, because a
 * "breakdown by candidate" added here in a hurry would reopen precisely what
 * closing exists to control.
 */
import { Hono } from 'hono'
import { requireRole, requireSession, type AuthedEnv } from '../middleware/requireRole.js'
import { pathParam } from '../http/params.js'

export const turnout = new Hono<AuthedEnv>()

turnout.get('/api/batches/:id/elections/:eid/turnout', requireRole('officer'), async (c) => {
  const batchId = requireSession(c).batchId
  const electionId = pathParam(c, 'eid')

  const election = await c.env.DB
    .prepare(`SELECT id FROM election WHERE id = ? AND batch_id = ?`)
    .bind(electionId, batchId)
    .first<{ id: string }>()
  if (!election) return c.json({ error: 'not found' }, 404)

  const row = await c.env.DB
    .prepare(
      `SELECT
         (SELECT count(*) FROM ballot WHERE election_id = ?2 AND voided = 0) AS ballots_cast,
         (SELECT count(*) FROM check_in ci
            JOIN voter_roll vr ON vr.batch_id = ci.batch_id AND vr.usu_id = ci.usu_id
           WHERE ci.batch_id = ?1 AND vr.eligible = 1) AS voters_checked_in,
         (SELECT count(*) FROM voter_roll WHERE batch_id = ?1 AND eligible = 1) AS eligible`,
    )
    .bind(batchId, electionId)
    .first<{ ballots_cast: number; voters_checked_in: number; eligible: number }>()

  return c.json({
    ballots_cast: row?.ballots_cast ?? 0,
    voters_checked_in: row?.voters_checked_in ?? 0,
    eligible: row?.eligible ?? 0,
  })
})
