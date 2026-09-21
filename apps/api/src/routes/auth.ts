/**
 * Officer and door sign-in.
 *
 * Each batch has two independent password hashes. The officer password
 * grants full control; the door password grants check-in only. A door
 * volunteer must never be able to become an officer, so each route verifies
 * the supplied password against its own column only — never both — and an
 * unknown batch id is answered identically to a wrong password (401) so a
 * caller cannot enumerate which batches exist.
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
  MIN_SECRET_LENGTH,
} from '../auth/session.js'
import { recordAudit } from '../db/audit.js'
import type { BatchRow } from '../db/types.js'
import { requireRole, type AuthedEnv } from '../middleware/requireRole.js'

const signInSchema = z.object({ password: z.string().min(1) })

// Officer and door TTLs, decided for Task 6: an AGM runs long, so forcing an
// officer to re-authenticate mid-count is worse than a longer session on a
// laptop they control. The door cookie lives on a volunteer's phone and
// should lapse sooner.
const TTL_SECONDS = { officer: 8 * 60 * 60, door: 60 * 60 } as const

type SignInRole = keyof typeof TTL_SECONDS

// A fixed, validly-formatted hash to run through verifyPassword when the
// batch does not exist, so an unknown batch id and a wrong password take a
// comparable code path rather than returning early with no PBKDF2 work done
// at all — belt-and-braces alongside the identical 401 status.
const DUMMY_HASH = 'pbkdf2-sha256$210000$BwcHBwcHBwcHBwcHBwcHBw==$wyu1lWWAh+nnX8b+mM2RXS+x6AYfbSoM8AAskjgywzs='

async function handleSignIn(c: Context<AuthedEnv>, role: SignInRole) {
  // Checked before any password work, and before the batch lookup, so a
  // misconfigured deployment fails on the very first sign-in attempt rather
  // than issuing tokens signed with a secret a laptop can crack overnight.
  // The response says nothing about the secret beyond "this server is not
  // configured" — the operator finds the detail in the Worker's logs.
  if (!isUsableSecret(c.env.SESSION_SECRET)) {
    throw new Error(`SESSION_SECRET must be at least ${MIN_SECRET_LENGTH} characters`)
  }

  const batchId = c.req.param('id')
  const parsed = signInSchema.safeParse(await c.req.json().catch(() => undefined))
  if (!parsed.success) {
    return c.json({ error: 'invalid request body' }, 400)
  }

  const row = await c.env.DB.prepare(`SELECT id, officer_hash, door_hash FROM batch WHERE id = ?`)
    .bind(batchId)
    .first<Pick<BatchRow, 'id' | 'officer_hash' | 'door_hash'>>()

  // Verify against this role's column only — never the other one.
  const hash = row ? (role === 'officer' ? row.officer_hash : row.door_hash) : DUMMY_HASH
  const ok = await verifyPassword(parsed.data.password, hash)

  if (!row || !ok) {
    // Only ever pass a batch id into recordAudit that we actually loaded
    // from the database — audit_log.batch_id has no foreign key, so an
    // unvalidated path param would sail straight through.
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
 * Sign-out. A volunteer handing a phone back at the end of their shift
 * otherwise leaves a live door session on it for up to an hour, on a device
 * nobody owns.
 *
 * Deliberately *not* behind `requireRole`: the commonest reason to sign out
 * is that something is wrong, and a session that has expired or been
 * tampered with must still be clearable. It is therefore idempotent and
 * always succeeds — clearing a cookie that is not there is not an error.
 */
async function handleSignOut(c: Context<AuthedEnv>, role: SignInRole) {
  const batchId = c.req.param('id')

  if (batchId) {
    const token = getCookie(c, cookieName(batchId, role))
    // Audit only a session we can actually verify, and attribute it to the
    // batch id inside our own signature rather than the raw path parameter —
    // audit_log has no foreign key to catch a typo'd id.
    if (token && isUsableSecret(c.env.SESSION_SECRET)) {
      const session = await verifySession(token, c.env.SESSION_SECRET)
      if (session && session.role === role && session.batchId === batchId) {
        await recordAudit(c.env.DB, { batchId: session.batchId, role, action: `session.${role}.signout` })
      }
    }
    // Same attributes as the cookie was set with, or the browser keeps it.
    deleteCookie(c, cookieName(batchId, role), { path: '/', secure: true, sameSite: 'Strict' })
  }

  return c.body(null, 204)
}

export const auth = new Hono<AuthedEnv>()

auth.post('/api/batches/:id/officer/session', (c) => handleSignIn(c, 'officer'))
auth.post('/api/batches/:id/door/session', (c) => handleSignIn(c, 'door'))

auth.delete('/api/batches/:id/officer/session', (c) => handleSignOut(c, 'officer'))
auth.delete('/api/batches/:id/door/session', (c) => handleSignOut(c, 'door'))

// Test seam only: proves requireRole('officer') end-to-end without reaching
// forward into Plan 2b's real officer endpoints. Delete once Plan 2b lands
// a genuine officer-gated route for the tests to exercise instead.
// TODO(plan-2b): delete this route as the first act of Plan 2b.
auth.get('/api/batches/:id/officer/ping', requireRole('officer'), (c) => c.json({ ok: true }))
