import { describe, it, expect } from 'vitest'
import { signSession, verifySession, type StaffSession, type Session } from '../src/auth/session.js'
import { SESSION_SECRET as SECRET } from './helpers.js'

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
  it('round-trips a staff session, and a voter session with its subject', async () => {
    expect(await verifySession(await signSession(base(), SECRET), SECRET)).toEqual(base())
    const voter = { batchId: 'b1', role: 'voter', subject: '1234567', exp: future } as const
    expect(await verifySession(await signSession(voter, SECRET), SECRET)).toEqual(voter)
  })

  it('rejects a token signed with a different secret', async () => {
    const t = await signSession(base(), SECRET)
    expect(await verifySession(t, 'other-secret-0123456789abcdef-pad')).toBeNull()
  })

  it('rejects a tampered payload', async () => {
    const t = await signSession(base(), SECRET)
    const forged = btoa(JSON.stringify(base({ batchId: 'b2' }))).replace(/=/g, '')
    expect(await verifySession(`${forged}.${t.split('.')[1]}`, SECRET)).toBeNull()
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
})

describe('a validly signed token with a bad payload', () => {
  // The ballot handler binds `session.subject` into a query, so a voter token
  // without one must not be accepted.
  it('rejects a voter token whose subject is missing, empty or not a string', async () => {
    for (const subject of [undefined, '', 1234567, null, {}, ['1234567']]) {
      const t = await signRaw({ batchId: 'b1', role: 'voter', subject, exp: future }, SECRET)
      expect(await verifySession(t, SECRET), JSON.stringify(subject)).toBeNull()
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
