/**
 * Signed session tokens in an HttpOnly cookie. The cookie name is scoped to
 * one batch and one role.
 */
import { timingSafeEqual } from './timing-safe-equal.js'

export type Role = 'officer' | 'door' | 'voter'

/** `subject?: undefined`, not omitted, so a staff session cannot carry one. */
export type StaffSession = {
  batchId: string
  role: 'officer' | 'door'
  subject?: undefined
  /** unix seconds */
  exp: number
}

export type VoterSession = {
  batchId: string
  role: 'voter'
  /** usu_id */
  subject: string
  /** unix seconds */
  exp: number
}

/** Discriminated on `role`: a voter session must have a `subject`. */
export type Session = StaffSession | VoterSession

/**
 * The payload is plaintext beside its signature. A short secret can be
 * brute-forced offline and then mints an officer session for any batch.
 * 32 matches `openssl rand -base64 32` (apps/api/README.md).
 */
export const MIN_SECRET_LENGTH = 32

/** Rejects a weak secret. WebCrypto already rejects a missing one. */
export function assertUsableSecret(secret: string): void {
  if (typeof secret !== 'string' || secret.length < MIN_SECRET_LENGTH) {
    // The message never includes the secret, its prefix or its length.
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

/** Imported once per isolate. Keyed by the secret, so rotation gets a new key. */
const keyCache = new Map<string, Promise<CryptoKey>>()

function hmacKey(secret: string): Promise<CryptoKey> {
  const cached = keyCache.get(secret)
  if (cached) return cached
  const key = crypto.subtle.importKey(
    'raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  )
  keyCache.set(secret, key)
  return key
}

async function hmac(data: string, secret: string): Promise<Uint8Array<ArrayBuffer>> {
  const key = await hmacKey(secret)
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(data)))
}

export async function signSession(session: Session, secret: string): Promise<string> {
  assertUsableSecret(secret)
  const payload = b64url(enc.encode(JSON.stringify(session)))
  return `${payload}.${b64url(await hmac(payload, secret))}`
}

/** The session, or null if the token is malformed, forged or expired. */
export async function verifySession(
  token: string,
  secret: string,
  now: number = Math.floor(Date.now() / 1000),
): Promise<Session | null> {
  // Also refused on verify: a deployment with a weak secret accepts nothing.
  if (!isUsableSecret(secret)) return null
  const parts = token.split('.')
  if (parts.length !== 2) return null
  const [payload, sig] = parts as [string, string]
  if (!payload || !sig) return null
  try {
    // Signature first. No field below affects whether we get here.
    if (!timingSafeEqual(await hmac(payload, secret), unb64url(sig))) return null
    const session = JSON.parse(new TextDecoder().decode(unb64url(payload))) as Partial<Session>
    if (typeof session.exp !== 'number' || session.exp <= now) return null
    if (session.role !== 'officer' && session.role !== 'door' && session.role !== 'voter') return null
    if (typeof session.batchId !== 'string' || session.batchId === '') return null

    // A voter token without a subject would reach the ballot query as undefined.
    if (session.role === 'voter') {
      if (typeof session.subject !== 'string' || session.subject === '') return null
      return { batchId: session.batchId, role: 'voter', subject: session.subject, exp: session.exp }
    }

    // A staff token must not carry a subject.
    if (session.subject !== undefined) return null
    return { batchId: session.batchId, role: session.role, exp: session.exp }
  } catch {
    return null
  }
}

export const cookieName = (batchId: string, role: Role): string => `es_${role}_${batchId}`

export const cookieOptions = (maxAgeSeconds: number) =>
  ({ httpOnly: true, secure: true, sameSite: 'Strict', path: '/', maxAge: maxAgeSeconds }) as const
