/**
 * Signed session tokens carried in an HttpOnly cookie.
 *
 * The password itself is never sent again after sign-in and never reaches
 * JavaScript, so an XSS cannot exfiltrate it. The cookie name is scoped to
 * one batch and one role, so a door volunteer's cookie cannot authorise an
 * officer route even on the same browser.
 */
import { timingSafeEqual } from './timing-safe-equal.js'

export type Role = 'officer' | 'door' | 'voter'

/**
 * An officer or door session. `subject` is typed `never`-ish (optional
 * `undefined`) rather than simply omitted so that a staff session cannot be
 * constructed *with* one by accident.
 */
export type StaffSession = {
  batchId: string
  role: 'officer' | 'door'
  subject?: undefined
  /** unix seconds */
  exp: number
}

/**
 * A voter session. `subject` is the voter's usu_id and is the value Plan 2b's
 * ballot handler binds into a D1 statement.
 */
export type VoterSession = {
  batchId: string
  role: 'voter'
  /** usu_id -- always present, by construction */
  subject: string
  /** unix seconds */
  exp: number
}

/**
 * Discriminated on `role` so `{ role: 'voter' }` cannot typecheck without a
 * `subject: string`. The threat this closes is not forgery -- these are our
 * own HMACs -- it is an `undefined` reaching a query under a type that said
 * it could not be undefined, which surfaces as a 500 on ballot submission.
 */
export type Session = StaffSession | VoterSession

/**
 * The session token's payload is plaintext base64url sitting beside its
 * signature in a cookie a door volunteer holds on their own phone. A short
 * secret is therefore brute-forceable offline: no rate limit, no lockout, no
 * detection, and recovering it mints `{ role: 'officer', batchId: <any> }`.
 * The entropy of this one value is the whole door -> officer boundary.
 *
 * 32 characters is the length of `openssl rand -base64 32`'s output floor,
 * which is what apps/api/README.md tells the operator to use.
 */
export const MIN_SECRET_LENGTH = 32

/**
 * Fails loudly at setup rather than silently at an AGM. A *missing* secret
 * already fails closed (WebCrypto rejects a zero-length HMAC key); this
 * covers the more dangerous case of a present-but-weak one, which otherwise
 * works perfectly right up until someone cracks it.
 */
export function assertUsableSecret(secret: string): void {
  if (typeof secret !== 'string' || secret.length < MIN_SECRET_LENGTH) {
    // The message never contains the secret, its prefix or its length.
    throw new Error(`SESSION_SECRET must be at least ${MIN_SECRET_LENGTH} characters`)
  }
}

export const isUsableSecret = (secret: string | undefined): boolean =>
  typeof secret === 'string' && secret.length >= MIN_SECRET_LENGTH

const enc = new TextEncoder()

const b64url = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

const unb64url = (s: string): Uint8Array<ArrayBuffer> => {
  const pad = s.replace(/-/g, '+').replace(/_/g, '/')
  return Uint8Array.from(atob(pad + '='.repeat((4 - (pad.length % 4)) % 4)), (c) => c.charCodeAt(0))
}

async function hmac(data: string, secret: string): Promise<Uint8Array<ArrayBuffer>> {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(data)))
}

export async function signSession(session: Session, secret: string): Promise<string> {
  // Minting is the choke point: nothing can carry a weak secret into
  // circulation without passing here first.
  assertUsableSecret(secret)
  const payload = b64url(enc.encode(JSON.stringify(session)))
  return `${payload}.${b64url(await hmac(payload, secret))}`
}

/**
 * Why a failure *reason* and not just `null`: the caller has to tell a
 * volunteer whose cookie lapsed mid-queue ("sign in again") from a caller who
 * is simply not allowed ("you cannot do this"). Both are refusals; only one of
 * them is fixable by the person holding the tablet.
 *
 * `expired` is distinguished only for a token whose signature already
 * verified, so it reveals nothing an unauthenticated caller did not already
 * hold.
 */
export type VerifyFailure = 'expired' | 'invalid'
export type VerifyResult = { ok: true; session: Session } | { ok: false; reason: VerifyFailure }

export async function verifySessionResult(
  token: string,
  secret: string,
  now: number = Math.floor(Date.now() / 1000),
): Promise<VerifyResult> {
  const bad = { ok: false, reason: 'invalid' } as const
  // A weak secret is refused on the verify side too, not only when minting.
  // Signing already rejects it, so a misconfigured deployment issues nothing
  // and has no legitimate (payload, signature) pair to attack offline. What
  // this closes is the remaining case: an attacker who guesses a short secret
  // and mints their own token. Without it the API would accept *only*
  // forgeries. With it, it accepts nothing.
  if (!isUsableSecret(secret)) return bad
  const parts = token.split('.')
  if (parts.length !== 2) return bad
  const [payload, sig] = parts as [string, string]
  if (!payload || !sig) return bad
  try {
    // Signature first: no field below can influence whether we get here.
    if (!timingSafeEqual(await hmac(payload, secret), unb64url(sig))) return bad
    const session = JSON.parse(new TextDecoder().decode(unb64url(payload))) as Partial<Session>
    if (typeof session.exp !== 'number') return bad
    if (session.exp <= now) return { ok: false, reason: 'expired' }
    if (session.role !== 'officer' && session.role !== 'door' && session.role !== 'voter') return bad
    if (typeof session.batchId !== 'string' || session.batchId === '') return bad

    // `subject` is checked, not assumed. Plan 2b's ballot handler reads it as
    // the voter's usu_id and binds it straight into a D1 statement; a voter
    // token without one would reach that query as `undefined` under a type
    // that promised a string, and fail at the one moment that must not fail.
    if (session.role === 'voter') {
      if (typeof session.subject !== 'string' || session.subject === '') return bad
      const voter: VoterSession = {
        batchId: session.batchId,
        role: 'voter',
        subject: session.subject,
        exp: session.exp,
      }
      return { ok: true, session: voter }
    }

    // Defensive, and cheap: an officer or door token has no business carrying
    // a subject. If one ever does, something minted it that should not have,
    // and the safe reading of an unexpected field is to refuse the token.
    if (session.subject !== undefined) return bad
    const staff: StaffSession = { batchId: session.batchId, role: session.role, exp: session.exp }
    return { ok: true, session: staff }
  } catch {
    return bad
  }
}

/** Reason-free form, for callers that only need "usable session or not". */
export async function verifySession(
  token: string,
  secret: string,
  now: number = Math.floor(Date.now() / 1000),
): Promise<Session | null> {
  const result = await verifySessionResult(token, secret, now)
  return result.ok ? result.session : null
}

export const cookieName = (batchId: string, role: Role): string => `es_${role}_${batchId}`

export const cookieOptions = (maxAgeSeconds: number) =>
  ({ httpOnly: true, secure: true, sameSite: 'Strict', path: '/', maxAge: maxAgeSeconds }) as const
