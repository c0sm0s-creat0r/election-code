import { describe, it, expect } from 'vitest'
import {
  signSession,
  verifySession,
  cookieName,
  cookieOptions,
  MIN_SECRET_LENGTH,
  type StaffSession,
  type Session,
} from '../src/auth/session.js'

const SECRET = 'test-session-secret-0123456789abcdef'
// StaffSession, because `Partial<Session>` does not spread cleanly over the union.
const base = (over: Partial<StaffSession> = {}): Session => ({
  batchId: 'b1', role: 'officer', exp: 9_999_999_999, ...over,
})

/**
 * Mints a validly signed token with an arbitrary payload, to test that
 * validation does not trust a payload because the HMAC verifies.
 */
const enc = new TextEncoder()
const b64url = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
async function signRaw(payloadObj: unknown, secret: string): Promise<string> {
  const payload = b64url(enc.encode(JSON.stringify(payloadObj)))
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(payload)))
  return `${payload}.${b64url(sig)}`
}

const future = 9_999_999_999

describe('session tokens', () => {
  it('round-trips a session', async () => {
    const t = await signSession(base(), SECRET)
    expect(await verifySession(t, SECRET)).toEqual(base())
  })

  it('rejects a token signed with a different secret', async () => {
    const t = await signSession(base(), SECRET)
    expect(await verifySession(t, 'other-secret-0123456789abcdef-pad')).toBeNull()
  })

  it('rejects a tampered payload', async () => {
    const t = await signSession(base(), SECRET)
    const [payload, sig] = t.split('.') as [string, string]
    const forged = btoa(JSON.stringify(base({ role: 'officer', batchId: 'b2' })))
      .replace(/=/g, '')
    expect(await verifySession(`${forged}.${sig}`, SECRET)).toBeNull()
    expect(payload).toBeTruthy()
  })

  it('rejects an expired token', async () => {
    const t = await signSession(base({ exp: 1_000 }), SECRET)
    expect(await verifySession(t, SECRET, 2_000)).toBeNull()
  })

  it('rejects garbage', async () => {
    for (const bad of ['', 'x', 'a.b.c', '.', 'notbase64.sig']) {
      expect(await verifySession(bad, SECRET)).toBeNull()
    }
  })

  it('scopes the cookie name to batch and role, so one does not authorise the other', async () => {
    expect(cookieName('b1', 'officer')).not.toBe(cookieName('b1', 'door'))
    expect(cookieName('b1', 'officer')).not.toBe(cookieName('b2', 'officer'))
  })

  it('sets HttpOnly, Secure, SameSite=Strict and a max age', () => {
    const o = cookieOptions(3600)
    expect(o.httpOnly).toBe(true)
    expect(o.secure).toBe(true)
    expect(o.sameSite).toBe('Strict')
    expect(o.maxAge).toBe(3600)
    expect(o.path).toBe('/')
  })
})

describe('voter session subject', () => {
  // The ballot handler binds `session.subject` into a query, so a voter token
  // without one must not be mintable or accepted.
  const voter = { batchId: 'b1', role: 'voter', subject: '1234567', exp: future } as const

  it('round-trips a voter session with its subject intact', async () => {
    const t = await signSession(voter, SECRET)
    const s = await verifySession(t, SECRET)
    expect(s).toEqual(voter)
    // The narrowing the union exists for:
    expect(s?.role === 'voter' ? s.subject : null).toBe('1234567')
  })

  it('rejects a voter token with no subject', async () => {
    const t = await signRaw({ batchId: 'b1', role: 'voter', exp: future }, SECRET)
    expect(await verifySession(t, SECRET)).toBeNull()
  })

  it('rejects a voter token with an empty subject', async () => {
    const t = await signRaw({ batchId: 'b1', role: 'voter', subject: '', exp: future }, SECRET)
    expect(await verifySession(t, SECRET)).toBeNull()
  })

  it('rejects a voter token whose subject is not a string', async () => {
    for (const subject of [1234567, null, {}, ['1234567']]) {
      const t = await signRaw({ batchId: 'b1', role: 'voter', subject, exp: future }, SECRET)
      expect(await verifySession(t, SECRET)).toBeNull()
    }
  })

  it('rejects an officer or door token that carries a subject at all', async () => {
    for (const role of ['officer', 'door']) {
      const t = await signRaw({ batchId: 'b1', role, subject: '1234567', exp: future }, SECRET)
      expect(await verifySession(t, SECRET)).toBeNull()
    }
  })

  it('does not let extra payload fields survive verification', async () => {
    const t = await signRaw({ batchId: 'b1', role: 'officer', exp: future, isSuper: true }, SECRET)
    expect(await verifySession(t, SECRET)).toEqual({ batchId: 'b1', role: 'officer', exp: future })
  })
})

describe('SESSION_SECRET strength', () => {
  // A short secret can be brute-forced offline from any token, then used to
  // mint an officer session.
  it('refuses to mint a token with a secret shorter than the minimum', async () => {
    for (const weak of ['', 'x', 'hunter2', 'test-secret-value', 'a'.repeat(MIN_SECRET_LENGTH - 1)]) {
      await expect(signSession(base(), weak)).rejects.toThrow(/SESSION_SECRET/)
    }
  })

  it('mints with a secret of exactly the minimum length', async () => {
    const secret = 'a'.repeat(MIN_SECRET_LENGTH)
    expect(typeof (await signSession(base(), secret))).toBe('string')
  })

  it('never puts the secret in the error it throws', async () => {
    const weak = 'weak-secret-do-not-leak'
    const err = await signSession(base(), weak).catch((e: unknown) => e)
    expect(String(err)).not.toContain(weak)
    expect(String(err)).not.toContain(String(weak.length))
  })

  it('requires at least 32 characters, matching `openssl rand -base64 32`', () => {
    expect(MIN_SECRET_LENGTH).toBe(32)
  })
})

describe('a weak SESSION_SECRET is refused on the verify side too', () => {
  const WEAK = 'short-secret'

  it('refuses a token even though its signature is genuine', async () => {
    // Signed with the weak secret, so the signature verifies. Verification must
    // still refuse it.
    const payload = btoa(JSON.stringify(base()))
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
    const key = await crypto.subtle.importKey(
      'raw', new TextEncoder().encode(WEAK), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
    const sigBytes = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload)))
    const sig = btoa(String.fromCharCode(...sigBytes))
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

    expect(await verifySession(`${payload}.${sig}`, WEAK)).toBeNull()
  })

  it('still accepts a token under a secret of the required length', async () => {
    const strong = 'x'.repeat(32)
    expect(await verifySession(await signSession(base(), strong), strong)).toEqual(base())
  })
})

