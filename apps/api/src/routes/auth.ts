/**
 * Officer and door sign-in. Each route verifies against its own hash column.
 * An unknown batch id gets the same 401 as a wrong password.
 */
import { Hono } from 'hono'
import { z } from 'zod'
import { setCookie, deleteCookie, getCookie } from 'hono/cookie'
import type { Context } from 'hono'
import { verifyPassword } from '../auth/password.js'
import {
  signSession,
  verifySession,
  cookieName,
  cookieOptions,
  isUsableSecret,
} from '../auth/session.js'
import { recordAudit } from '../db/audit.js'
import { notConfigured } from '../http/notConfigured.js'
import type { BatchRow } from '../db/types.js'
import { requireRole, type AuthedEnv } from '../middleware/requireRole.js'
import { rateLimit, RATE_LIMITS } from '../middleware/rateLimit.js'

const signInSchema = z.object({ password: z.string().min(1) })

// The officer's laptop is their own and an AGM runs long. The door cookie is
// on a volunteer's phone, so it expires sooner.
const TTL_SECONDS = { officer: 8 * 60 * 60, door: 60 * 60 } as const

type SignInRole = keyof typeof TTL_SECONDS

// Verified against when the batch does not exist, so an unknown id costs the
// same PBKDF2 work as a wrong password. The iteration count must match
// password.ts.
const DUMMY_HASH = 'pbkdf2-sha256$100000$BwcHBwcHBwcHBwcHBwcHBw==$xl+cmf7KzCjhMIgwm24j5zJdLtkUvSCoFpYH1NYVjrg='

async function handleSignIn(c: Context<AuthedEnv>, role: SignInRole) {
  // Checked first: a misconfigured deployment issues no weakly signed token.
  if (!isUsableSecret(c.env.SESSION_SECRET)) return notConfigured(c)

  const batchId = c.req.param('id')
  const parsed = signInSchema.safeParse(await c.req.json().catch(() => undefined))
  if (!parsed.success) {
    return c.json({ error: 'invalid request body' }, 400)
  }

  const row = await c.env.DB.prepare(`SELECT id, officer_hash, door_hash FROM batch WHERE id = ?`)
    .bind(batchId)
    .first<Pick<BatchRow, 'id' | 'officer_hash' | 'door_hash'>>()

  // this role's column only
  const hash = row ? (role === 'officer' ? row.officer_hash : row.door_hash) : DUMMY_HASH
  const ok = await verifyPassword(parsed.data.password, hash)

  if (!row || !ok) {
    // audit_log has no foreign key. Use only a batch id loaded from the database.
    if (row) {
      await recordAudit(c.env.DB, { batchId: row.id, role, action: `session.${role}.fail` })
    }
    return c.json({ error: 'unauthorized' }, 401)
  }

  const ttl = TTL_SECONDS[role]
  const exp = Math.floor(Date.now() / 1000) + ttl
  const token = await signSession({ batchId: row.id, role, exp }, c.env.SESSION_SECRET)
  setCookie(c, cookieName(row.id, role), token, cookieOptions(ttl))
  await recordAudit(c.env.DB, { batchId: row.id, role, action: `session.${role}.ok` })

  return c.json({ ok: true, role })
}

/**
 * Sign-out. Not behind `requireRole`: an expired or tampered session must
 * still clear. Idempotent.
 */
async function handleSignOut(c: Context<AuthedEnv>, role: SignInRole) {
  const batchId = c.req.param('id')

  if (batchId) {
    const token = getCookie(c, cookieName(batchId, role))
    // Audit only a session that verifies, under the batch id in the signature,
    // not the path parameter.
    if (token && isUsableSecret(c.env.SESSION_SECRET)) {
      const session = await verifySession(token, c.env.SESSION_SECRET)
      if (session && session.role === role && session.batchId === batchId) {
        await recordAudit(c.env.DB, { batchId: session.batchId, role, action: `session.${role}.signout` })
      }
    }
    // Same attributes as when the cookie was set, or the browser keeps it.
    deleteCookie(c, cookieName(batchId, role), { path: '/', secure: true, sameSite: 'Strict' })
  }

  return c.body(null, 204)
}

export const auth = new Hono<AuthedEnv>()

// The limiter runs first: a 429 costs no PBKDF2 and writes no audit row.
const staffSignInLimit = rateLimit(RATE_LIMITS.staffSignIn)

auth.post('/api/batches/:id/officer/session', staffSignInLimit, (c) => handleSignIn(c, 'officer'))
auth.post('/api/batches/:id/door/session', staffSignInLimit, (c) => handleSignIn(c, 'door'))

auth.delete('/api/batches/:id/officer/session', (c) => handleSignOut(c, 'officer'))
auth.delete('/api/batches/:id/door/session', (c) => handleSignOut(c, 'door'))

/**
 * Is this session still valid? A frontend can ask before its first request
 * 401s. The auth tests also use it as a gated route with no setup.
 */
auth.get('/api/batches/:id/officer/ping', requireRole('officer'), (c) => c.json({ ok: true }))
