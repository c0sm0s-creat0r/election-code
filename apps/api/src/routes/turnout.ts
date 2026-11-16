/**
 * Turnout while voting is open, and nothing else. Never add a per-candidate
 * figure: no tally exists before close.
 */
import { Hono } from 'hono'
import { requireRole, requireSession, type AuthedEnv } from '../middleware/requireRole.js'

export const turnout = new Hono<AuthedEnv>()

turnout.get('/api/batches/:id/elections/:eid/turnout', requireRole('officer'), async (c) => {
  const batchId = requireSession(c).batchId
  const electionId = c.req.param('eid')

  // One statement, `found` included: clients poll this every few seconds.
  const row = await c.env.DB
    .prepare(
      `SELECT
         (SELECT count(*) FROM election WHERE id = ?2 AND batch_id = ?1) AS found,
         (SELECT count(*) FROM ballot WHERE election_id = ?2 AND voided = 0) AS ballots_cast,
         (SELECT count(*) FROM check_in ci
            JOIN voter_roll vr ON vr.batch_id = ci.batch_id AND vr.usu_id = ci.usu_id
           WHERE ci.batch_id = ?1 AND vr.eligible = 1) AS voters_checked_in,
         (SELECT count(*) FROM voter_roll WHERE batch_id = ?1 AND eligible = 1) AS eligible,
         (SELECT count(*) FROM voter_roll WHERE batch_id = ?1 AND added_at_door = 1) AS added_at_door`,
    )
    .bind(batchId, electionId)
    .first<{
      found: number
      ballots_cast: number
      voters_checked_in: number
      eligible: number
      added_at_door: number
    }>()

  if (!row || row.found === 0) return c.json({ error: 'not found' }, 404)

  // `added_at_door` is always returned with the totals.
  return c.json({
    ballots_cast: row.ballots_cast,
    voters_checked_in: row.voters_checked_in,
    eligible: row.eligible,
    added_at_door: row.added_at_door,
  })
})
