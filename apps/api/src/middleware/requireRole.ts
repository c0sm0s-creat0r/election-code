/**
 * Role gate for officer, door and voter routes.
 *
 *   401: unknown caller (no cookie, bad signature, expired).
 *   403: valid session, wrong role or wrong batch.
 */
import type { Context, Next } from 'hono'
import { getCookie } from 'hono/cookie'
import type { Env } from '../index.js'
import { verifySession, cookieName, type Role, type Session } from '../auth/session.js'

// `undefined` until `requireRole` has run, so a route without the middleware
// must narrow before reading a session.
export type AuthedEnv = { Bindings: Env; Variables: { session: Session | undefined } }

/** The session, for a handler behind `requireRole`. Throws if it did not run. */
export function requireSession(c: Context<AuthedEnv>): Session {
  const session = c.get('session')
  if (!session) throw new Error('requireSession called without requireRole having run')
  return session
}

const ALL_ROLES: readonly Role[] = ['officer', 'door', 'voter']

export function requireRole(role: Role) {
  return async (c: Context<AuthedEnv>, next: Next) => {
    const batchId = c.req.param('id')
    if (!batchId) return c.json({ error: 'unauthenticated' }, 401)

    // The signature does not cover the cookie name, so check role and batch on
    // each token. A valid session under another role is a 403, not a sign-in
    // prompt.
    for (const name of [role, ...ALL_ROLES.filter((r) => r !== role)]) {
      const token = getCookie(c, cookieName(batchId, name))
      if (token === undefined) continue
      const session = await verifySession(token, c.env.SESSION_SECRET)
      if (name === role) {
        if (!session) return c.json({ error: 'unauthenticated' }, 401)
        if (session.role !== role || session.batchId !== batchId) return c.json({ error: 'forbidden' }, 403)
        c.set('session', session)
        return next()
      }
      if (session && session.role === name && session.batchId === batchId) {
        return c.json({ error: 'forbidden' }, 403)
      }
    }
    return c.json({ error: 'unauthenticated' }, 401)
  }
}
