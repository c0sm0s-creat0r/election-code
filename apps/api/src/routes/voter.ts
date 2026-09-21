/**
 * Voter sign-in: USU id **and** surname, both matching the roll.
 *
 * **Why both.** Looking a voter up by id alone and echoing their name back is
 * an enumeration oracle over a seven-digit space — anyone could walk it and map
 * ids to real names. Requiring the surname gives nothing away on a wrong guess:
 * a wrong surname and an unknown id return a byte-identical 401. This is the
 * same reasoning as the DUMMY_HASH on staff sign-in.
 *
 * **401 versus 403 is a deliberate split, and it does leak one bit.** A voter
 * who is on the roll and passes the surname but is not checked in, or is marked
 * ineligible, gets a 403 with a code — because both are fixable at the door and
 * standing in a queue being told "unauthorized" helps nobody. The cost is that
 * someone who already knows a member's id *and* surname learns whether they
 * have arrived. That is information a person in the room can see anyway, and it
 * is worth it for a voter who would otherwise be stuck.
 *
 * **The session carries `subject` = usu_id.** `Session` is a discriminated
 * union, so `{ role: 'voter' }` cannot typecheck without it. routes/ballots.ts
 * reads it to identify the voter — and never treats it as proof of eligibility.
 */
import { Hono } from 'hono'
import { z } from 'zod'
import { setCookie } from 'hono/cookie'
import {
  signSession,
  cookieName,
  cookieOptions,
  isUsableSecret,
  MIN_SECRET_LENGTH,
} from '../auth/session.js'
import { recordAudit } from '../db/audit.js'
import { rateLimit, RATE_LIMITS } from '../middleware/rateLimit.js'
import { pathParam } from '../http/params.js'
import type { AuthedEnv } from '../middleware/requireRole.js'

const voterSignInSchema = z.object({
  usu_id: z.string().min(1).max(32),
  surname: z.string().min(1).max(200),
})

/**
 * Four hours. Long enough to cover an AGM including a late-running agenda, and
 * short enough that a phone left on a table is not a live session tomorrow.
 * Ballot submission re-verifies eligibility regardless of how fresh the cookie
 * is, so the TTL is a convenience bound rather than a security control.
 */
const VOTER_TTL_SECONDS = 4 * 60 * 60

export const voter = new Hono<AuthedEnv>()

voter.post(
  '/api/batches/:id/voter/session',
  rateLimit(RATE_LIMITS.voting),
  async (c) => {
    if (!isUsableSecret(c.env.SESSION_SECRET)) {
      throw new Error(`SESSION_SECRET must be at least ${MIN_SECRET_LENGTH} characters`)
    }

    const batchId = pathParam(c, 'id')
    const parsed = voterSignInSchema.safeParse(await c.req.json().catch(() => undefined))
    if (!parsed.success) return c.json({ error: 'invalid request body' }, 400)
    const { usu_id: usuId, surname } = parsed.data

    // One query. The surname comparison is in SQL so that a member who exists
    // and a member who does not take the same path, and `checked_in_at` comes
    // back in the same round trip rather than a second lookup that would need
    // its own not-found branch.
    const row = await c.env.DB
      .prepare(
        `SELECT vr.first_name, vr.eligible, ci.checked_in_at
           FROM voter_roll vr
           LEFT JOIN check_in ci ON ci.batch_id = vr.batch_id AND ci.usu_id = vr.usu_id
          WHERE vr.batch_id = ?1 AND vr.usu_id = ?2
            AND lower(trim(vr.last_name)) = lower(trim(?3))`,
      )
      .bind(batchId, usuId, surname)
      .first<{ first_name: string; eligible: number; checked_in_at: number | null }>()

    if (!row) {
      // Identical for an unknown id and a wrong surname. No audit row: this
      // route is unauthenticated and a miss here is attacker-controllable, so
      // logging every one is a way to flood the trail. The rate limiter is
      // what bounds guessing.
      return c.json({ error: 'unauthorized' }, 401)
    }

    if (row.eligible === 0) {
      await recordAudit(c.env.DB, { batchId, role: 'voter', action: 'session.voter.fail' })
      return c.json({ error: 'not an eligible member', code: 'ineligible' }, 403)
    }
    if (row.checked_in_at === null) {
      await recordAudit(c.env.DB, { batchId, role: 'voter', action: 'session.voter.fail' })
      return c.json({ error: 'not checked in at the door', code: 'not_checked_in' }, 403)
    }

    const exp = Math.floor(Date.now() / 1000) + VOTER_TTL_SECONDS
    const token = await signSession({ batchId, role: 'voter', subject: usuId, exp }, c.env.SESSION_SECRET)
    setCookie(c, cookieName(batchId, 'voter'), token, cookieOptions(VOTER_TTL_SECONDS))

    await recordAudit(c.env.DB, { batchId, role: 'voter', action: 'session.voter.ok' })

    return c.json({ first_name: row.first_name })
  },
)
