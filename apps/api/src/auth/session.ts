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

export type Session = {
  batchId: string
  role: Role
  /** usu_id for a voter session; absent for officer/door */
  subject?: string
  /** unix seconds */
  exp: number
}

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
  const payload = b64url(enc.encode(JSON.stringify(session)))
  return `${payload}.${b64url(await hmac(payload, secret))}`
}

export async function verifySession(
  token: string,
  secret: string,
  now: number = Math.floor(Date.now() / 1000),
): Promise<Session | null> {
  const parts = token.split('.')
  if (parts.length !== 2) return null
  const [payload, sig] = parts as [string, string]
  if (!payload || !sig) return null
  try {
    if (!timingSafeEqual(await hmac(payload, secret), unb64url(sig))) return null
    const session = JSON.parse(new TextDecoder().decode(unb64url(payload))) as Session
    if (typeof session.exp !== 'number' || session.exp <= now) return null
    if (session.role !== 'officer' && session.role !== 'door' && session.role !== 'voter') return null
    if (typeof session.batchId !== 'string' || session.batchId === '') return null
    return session
  } catch {
    return null
  }
}

export const cookieName = (batchId: string, role: Role): string => `es_${role}_${batchId}`

export const cookieOptions = (maxAgeSeconds: number) =>
  ({ httpOnly: true, secure: true, sameSite: 'Strict', path: '/', maxAge: maxAgeSeconds }) as const
