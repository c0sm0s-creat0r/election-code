/**
 * Role gate for officer, door and voter routes.
 *
 * The cookie name scopes by batch and role. The `session.batchId` check
 * below also catches a validly signed token under the wrong cookie name.
 *
 *   401: unknown caller (no cookie, bad signature, expired).
 *   403: valid session, wrong role or wrong batch.
 *
 * A lapsed door cookie must produce a password prompt, not a permission
 * error. The 401 body carries a `code`.
 */
import type { Context, Next } from 'hono'
import { getCookie } from 'hono/cookie'
import type { Env } from '../index.js'
import { verifySession, verifySessionResult, cookieName, type Role, type Session } from '../auth/session.js'

// `undefined` until `requireRole` has run, so a route without the middleware
// must narrow before reading a session.
export type AuthedEnv = { Bindings: Env; Variables: { session: Session | undefined } }

export type UnauthenticatedCode = 'no_session' | 'expired' | 'invalid'

const unauthenticated = (c: Context<AuthedEnv>, code: UnauthenticatedCode) =>
  c.json({ error: 'unauthenticated', code }, 401)

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
    if (!batchId) return unauthenticated(c, 'no_session')

    const token = getCookie(c, cookieName(batchId, role))

    if (token === undefined) {
      // A valid session for this batch under another role: 403, not a sign-in
      // prompt.
      for (const other of ALL_ROLES) {
        if (other === role) continue
        const otherToken = getCookie(c, cookieName(batchId, other))
        if (otherToken === undefined) continue
        // The signature does not cover the cookie name, so check the token matches
        // it.
        const otherSession = await verifySession(otherToken, c.env.SESSION_SECRET)
        if (otherSession && otherSession.role === other && otherSession.batchId === batchId) {
          return c.json({ error: 'forbidden' }, 403)
        }
      }
      return unauthenticated(c, 'no_session')
    }

    const result = await verifySessionResult(token, c.env.SESSION_SECRET)
    if (!result.ok) return unauthenticated(c, result.reason)

    // The session is genuine from here. Any refusal is about authority.
    const { session } = result
    if (session.role !== role || session.batchId !== batchId) {
      return c.json({ error: 'forbidden' }, 403)
    }

    c.set('session', session)
    await next()
  }
}
