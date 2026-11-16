/**
 * Voter sign-in: USU id and surname, both matching the roll.
 *
 * Both, because a lookup by id that echoed a name would map ids to names. A
 * wrong surname and an unknown id return the same 401.
 *
 * On the roll but ineligible or not checked in gets a 403 with a code: both
 * are fixable at the door. This tells someone who knows a member's id and
 * surname whether they have arrived. Accepted.
 *
 * The session's `subject` is the usu_id. ballots.ts uses it to identify the
 * voter, never as proof of eligibility.
 */
import { Hono } from 'hono'
import { z } from 'zod'
import { setCookie } from 'hono/cookie'
import {
  signSession,
  cookieName,
  cookieOptions,
  isUsableSecret,
} from '../auth/session.js'
import { recordAudit } from '../db/audit.js'
import { notConfigured } from '../http/notConfigured.js'
import { rateLimit, RATE_LIMITS } from '../middleware/rateLimit.js'
import { pathParam } from '../http/params.js'
import type { AuthedEnv } from '../middleware/requireRole.js'

const voterSignInSchema = z.object({
  usu_id: z.string().min(1).max(32),
  surname: z.string().min(1).max(200),
})

/**
 * Long enough for a late AGM. Not a control: ballot submission re-checks
 * eligibility.
 */
const VOTER_TTL_SECONDS = 4 * 60 * 60

export const voter = new Hono<AuthedEnv>()

voter.post(
  '/api/batches/:id/voter/session',
  rateLimit(RATE_LIMITS.voting),
  async (c) => {
    if (!isUsableSecret(c.env.SESSION_SECRET)) return notConfigured(c)

    const batchId = pathParam(c, 'id')
    const parsed = voterSignInSchema.safeParse(await c.req.json().catch(() => undefined))
    if (!parsed.success) return c.json({ error: 'invalid request body' }, 400)
    const { usu_id: usuId, surname } = parsed.data

    // The surname is compared in SQL, so an unknown id and a wrong surname take
    // the same path.
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
      // No audit row: an unauthenticated miss is attacker-controlled and would
      // flood the log. The rate limiter bounds guessing.
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
