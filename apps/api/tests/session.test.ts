import { describe, it, expect } from 'vitest'
import { signSession, verifySession, cookieName, cookieOptions, type Session } from '../src/auth/session.js'

const SECRET = 'test-secret-value'
const base = (over: Partial<Session> = {}): Session => ({
  batchId: 'b1', role: 'officer', exp: 9_999_999_999, ...over,
})

describe('session tokens', () => {
  it('round-trips a session', async () => {
    const t = await signSession(base(), SECRET)
    expect(await verifySession(t, SECRET)).toEqual(base())
  })

  it('rejects a token signed with a different secret', async () => {
    const t = await signSession(base(), SECRET)
    expect(await verifySession(t, 'other-secret')).toBeNull()
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
