/**
 * Role-gating middleware for every officer/door route in Plan 2b.
 *
 * `cookieName` already scopes the cookie by batch and role, so a door
 * cookie is never even read on an officer route, and a batch-Y cookie is
 * never read on a batch-X route — but the explicit `session.batchId`
 * comparison below is the second layer: a validly-signed token for another
 * batch must still be rejected even if it somehow arrives under the right
 * cookie name (e.g. a forged Cookie header).
 *
 * **401 and 403 are not interchangeable here.** An AGM runs past the door
 * cookie's hour with the check-in queue still moving. When that cookie
 * lapses, a blanket 403 tells the tablet "you are not allowed to do this" —
 * so it shows a permission error instead of a password prompt, in front of a
 * queue of 1,300 people, and the volunteer has no way to know that signing in
 * again is the entire fix. So:
 *
 *   401 — we do not know who you are: no cookie, bad signature, expired.
 *   403 — we know exactly who you are, and it is not who this route needs:
 *         a *valid* session of the wrong role or for the wrong batch.
 *
 * The 401 body carries a machine-readable `code` so a frontend can act on
 * the difference without parsing prose.
 */
import type { Context, Next } from 'hono'
import { getCookie } from 'hono/cookie'
import type { Env } from '../index.js'
import { verifySession, verifySessionResult, cookieName, type Role, type Session } from '../auth/session.js'

// `session` is only ever populated by `requireRole` actually running on this
// request. Typing it as always-present `Session` would let a Plan 2b route
// that forgets to compose the middleware read a confident `Session` over a
// runtime `undefined` — invisible in types, absent from tests, surfacing at
// an AGM. `Session | undefined` forces every reader to narrow.
export type AuthedEnv = { Bindings: Env; Variables: { session: Session | undefined } }

export type UnauthenticatedCode = 'no_session' | 'expired' | 'invalid'

const unauthenticated = (c: Context<AuthedEnv>, code: UnauthenticatedCode) =>
  c.json({ error: 'unauthenticated', code }, 401)

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

const ALL_ROLES: readonly Role[] = ['officer', 'door', 'voter']

export function requireRole(role: Role) {
  return async (c: Context<AuthedEnv>, next: Next) => {
    const batchId = c.req.param('id')
    if (!batchId) return unauthenticated(c, 'no_session')

    const token = getCookie(c, cookieName(batchId, role))

    if (token === undefined) {
      // No cookie for *this* role. Before calling that "unauthenticated",
      // check whether the caller holds a valid session for this batch under
      // another role — a door volunteer tapping an officer route is
      // authenticated and simply not authorised, and telling them to sign in
      // again would be a lie that sends them round a loop. Their password
      // grants the door role and nothing more.
      for (const other of ALL_ROLES) {
        if (other === role) continue
        const otherToken = getCookie(c, cookieName(batchId, other))
        if (otherToken === undefined) continue
        // Verify the token actually IS what its cookie name claims. The name
        // is not covered by the signature, so a hand-forged Cookie header can
        // file any token under any name; without these two checks a token for
        // another batch, or another role entirely, would earn a 403 here where
        // 401 is the truthful answer.
        const otherSession = await verifySession(otherToken, c.env.SESSION_SECRET)
        if (otherSession && otherSession.role === other && otherSession.batchId === batchId) {
          return c.json({ error: 'forbidden' }, 403)
        }
      }
      return unauthenticated(c, 'no_session')
    }

    const result = await verifySessionResult(token, c.env.SESSION_SECRET)
    if (!result.ok) return unauthenticated(c, result.reason)

    // From here the session is genuine: any refusal is about authority.
    const { session } = result
    if (session.role !== role || session.batchId !== batchId) {
      return c.json({ error: 'forbidden' }, 403)
    }

    c.set('session', session)
    await next()
  }
}
