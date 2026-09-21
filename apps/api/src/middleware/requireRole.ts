/**
 * Role-gating middleware for every officer/door route in Plan 2b.
 *
 * `cookieName` already scopes the cookie by batch and role, so a door
 * cookie is never even read on an officer route, and a batch-Y cookie is
 * never read on a batch-X route — but the explicit `session.batchId`
 * comparison below is the second layer: a validly-signed token for another
 * batch must still be rejected even if it somehow arrives under the right
 * cookie name (e.g. a forged Cookie header). Any failure is 403.
 */
import type { Context, Next } from 'hono'
import { getCookie } from 'hono/cookie'
import type { Env } from '../index.js'
import { verifySession, cookieName, type Role, type Session } from '../auth/session.js'

// `session` is only ever populated by `requireRole` actually running on this
// request. Typing it as always-present `Session` would let a Plan 2b route
// that forgets to compose the middleware read a confident `Session` over a
// runtime `undefined` — invisible in types, absent from tests, surfacing at
// an AGM. `Session | undefined` forces every reader to narrow.
export type AuthedEnv = { Bindings: Env; Variables: { session: Session | undefined } }

/**
 * Narrows `c.get('session')` for a handler that is only ever reached behind
 * `requireRole`. Throws (Hono turns this into a 500) if somehow called
 * without the middleware having run, rather than silently trusting an
 * `undefined` as a `Session`.
 */
export function requireSession(c: Context<AuthedEnv>): Session {
  const session = c.get('session')
  if (!session) throw new Error('requireSession called without requireRole having run')
  return session
}

export function requireRole(role: Role) {
  return async (c: Context<AuthedEnv>, next: Next) => {
    const batchId = c.req.param('id')
    const token = batchId ? getCookie(c, cookieName(batchId, role)) : undefined
    const session = token ? await verifySession(token, c.env.SESSION_SECRET) : null

    if (!session || session.role !== role || session.batchId !== batchId) {
      return c.json({ error: 'forbidden' }, 403)
    }

    c.set('session', session)
    await next()
  }
}
