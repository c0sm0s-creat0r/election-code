import { describe, it, expect, beforeEach } from 'vitest'
import { SELF, env, applyD1Migrations } from 'cloudflare:test'
import { signSession } from '../src/auth/session.js'

const KEY = 'super-secret-test-key'
const SECRET = 'test-session-secret-0123456789abcdef'
let batchId = ''

beforeEach(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS)
  await env.DB.prepare('DELETE FROM audit_log').run()
  await env.DB.prepare('DELETE FROM batch').run()
  const res = await SELF.fetch('https://example.com/api/batches', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-super-admin-key': KEY },
    body: JSON.stringify({
      name: 'N', slug: 's', officer_password: 'officer-password-1', door_password: 'door-password-1',
      branding: { title: 't', org_name: 'o', accent_color: '#000000', logo_url: '' },
    }),
  })
  batchId = (await res.json() as { id: string }).id
})

const signIn = (role: 'officer' | 'door', password: string, id: string = batchId) =>
  SELF.fetch(`https://example.com/api/batches/${id}/${role}/session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password }),
  })

describe('sign-in', () => {
  it('accepts the officer password and sets an HttpOnly cookie', async () => {
    const res = await signIn('officer', 'officer-password-1')
    expect(res.status).toBe(200)
    const cookie = res.headers.get('set-cookie') ?? ''
    expect(cookie).toMatch(/HttpOnly/i)
    expect(cookie).toMatch(/Secure/i)
    expect(cookie).toMatch(/SameSite=Strict/i)
  })

  it('accepts the door password', async () => {
    expect((await signIn('door', 'door-password-1')).status).toBe(200)
  })

  it('rejects a wrong password', async () => {
    expect((await signIn('officer', 'nope')).status).toBe(401)
  })

  it('does NOT accept the door password on the officer route', async () => {
    // the whole point of two passwords: a door volunteer cannot become an officer
    expect((await signIn('officer', 'door-password-1')).status).toBe(401)
  })

  it('does NOT accept the officer password on the door route', async () => {
    expect((await signIn('door', 'officer-password-1')).status).toBe(401)
  })

  it('never echoes the password', async () => {
    expect(await (await signIn('officer', 'officer-password-1')).text()).not.toContain('officer-password-1')
  })

  it('404s an unknown batch without revealing whether it exists', async () => {
    const res = await SELF.fetch(`https://example.com/api/batches/${crypto.randomUUID()}/officer/session`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'x' }),
    })
    expect([401, 404]).toContain(res.status)
  })

  it('writes an audit row on success and on failure', async () => {
    await signIn('officer', 'officer-password-1')
    await signIn('officer', 'wrong')
    const rows = await env.DB.prepare(`SELECT action FROM audit_log WHERE action LIKE 'session%'`).all<{ action: string }>()
    expect(rows.results.map(r => r.action).sort()).toEqual(['session.officer.fail', 'session.officer.ok'])
  })

  it('sets the officer cookie max-age to 8 hours', async () => {
    const cookie = (await signIn('officer', 'officer-password-1')).headers.get('set-cookie') ?? ''
    expect(cookie).toMatch(/Max-Age=28800\b/i)
  })

  it('sets the door cookie max-age to 1 hour', async () => {
    const cookie = (await signIn('door', 'door-password-1')).headers.get('set-cookie') ?? ''
    expect(cookie).toMatch(/Max-Age=3600\b/i)
  })

  it('scopes the officer cookie name to this batch and role', async () => {
    const cookie = (await signIn('officer', 'officer-password-1')).headers.get('set-cookie') ?? ''
    expect(cookie).toMatch(new RegExp(`es_officer_${batchId}=`))
  })
})

describe('requireRole middleware (via the officer test-seam route)', () => {
  const ping = (cookie: string, id: string = batchId) =>
    SELF.fetch(`https://example.com/api/batches/${id}/officer/ping`, {
      headers: cookie ? { cookie } : {},
    })

  it('allows an officer session through', async () => {
    const setCookie = (await signIn('officer', 'officer-password-1')).headers.get('set-cookie') ?? ''
    const cookie = (setCookie.split(';')[0]) ?? ''
    const res = await ping(cookie)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
  })

  it('401s with no session cookie at all, with a machine-readable code', async () => {
    // Changed from 403 in the whole-branch review: "we do not know who you
    // are" is an authentication failure. A 403 here tells a frontend the
    // caller is not allowed, so it shows a permission error where it should
    // show a sign-in prompt.
    const res = await ping('')
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: 'unauthenticated', code: 'no_session' })
  })

  it('rejects a door session on an officer-gated route: a door volunteer must never become an officer', async () => {
    const setCookie = (await signIn('door', 'door-password-1')).headers.get('set-cookie') ?? ''
    const cookie = (setCookie.split(';')[0]) ?? ''
    const res = await ping(cookie)
    expect(res.status).toBe(403)
  })

  it('rejects a validly-signed officer session for a different batch id', async () => {
    // A forged/foreign token cannot be smuggled in by hitting a different
    // batch's route with a cookie whose batchId doesn't match the route.
    const otherId = crypto.randomUUID()
    const token = await signSession({ batchId: otherId, role: 'officer', exp: Math.floor(Date.now() / 1000) + 3600 }, SECRET)
    // Hit the *real* batch's route while carrying a cookie sent under that
    // batch's own cookie name, but whose signed payload names otherId — the
    // browser would never construct this, but the middleware's explicit
    // batchId comparison must not rely solely on the cookie name matching.
    const res = await SELF.fetch(`https://example.com/api/batches/${batchId}/officer/ping`, {
      headers: { cookie: `es_officer_${batchId}=${token}` },
    })
    expect(res.status).toBe(403)
  })

  it('401s a tampered/garbage cookie value', async () => {
    // Also changed from 403: a token that fails its signature identifies
    // nobody, so there is no authority to forbid. It is still refused.
    const res = await ping(`es_officer_${batchId}=not-a-real-token`)
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: 'unauthenticated', code: 'invalid' })
  })

  it('401s an expired but validly-signed officer session, distinguishably', async () => {
    // The AGM case: the volunteer's hour is up mid-queue. The tablet must be
    // able to tell "sign in again" from "you are not allowed".
    const token = await signSession(
      { batchId, role: 'officer', exp: Math.floor(Date.now() / 1000) - 1 },
      SECRET,
    )
    const res = await ping(`es_officer_${batchId}=${token}`)
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: 'unauthenticated', code: 'expired' })
  })

  it('403s — not 401 — a valid session of the wrong role, so the tablet is not sent round a sign-in loop', async () => {
    const setCookie = (await signIn('door', 'door-password-1')).headers.get('set-cookie') ?? ''
    const cookie = (setCookie.split(';')[0]) ?? ''
    const res = await ping(cookie)
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: 'forbidden' })
  })

  it('never returns a token, hash or password in an auth failure body', async () => {
    for (const res of [await ping(''), await ping(`es_officer_${batchId}=not-a-real-token`)]) {
      const text = await res.text()
      expect(text).not.toContain('pbkdf2')
      expect(text).not.toContain('officer-password-1')
      expect(text).not.toContain(SECRET)
    }
  })
})

describe('sign-out', () => {
  const signOut = (role: 'officer' | 'door', cookie: string, id: string = batchId) =>
    SELF.fetch(`https://example.com/api/batches/${id}/${role}/session`, {
      method: 'DELETE',
      headers: cookie ? { cookie } : {},
    })

  const cookieFrom = (res: Response) => (res.headers.get('set-cookie') ?? '').split(';')[0] ?? ''

  it('clears the door cookie so a handed-back phone carries no live session', async () => {
    const cookie = cookieFrom(await signIn('door', 'door-password-1'))
    const res = await signOut('door', cookie)
    expect(res.status).toBe(204)
    const cleared = res.headers.get('set-cookie') ?? ''
    expect(cleared).toMatch(new RegExp(`es_door_${batchId}=`))
    expect(cleared).toMatch(/Max-Age=0\b/i)
  })

  it('makes the officer cookie stop working on a gated route', async () => {
    const cookie = cookieFrom(await signIn('officer', 'officer-password-1'))
    expect((await SELF.fetch(`https://example.com/api/batches/${batchId}/officer/ping`, { headers: { cookie } })).status).toBe(200)
    await signOut('officer', cookie)
    // The browser drops the cookie on Max-Age=0; the server cannot revoke a
    // signed token, so this asserts the instruction was issued, and that the
    // route still gates correctly once the cookie is gone.
    expect((await SELF.fetch(`https://example.com/api/batches/${batchId}/officer/ping`, {})).status).toBe(401)
  })

  it('succeeds with no cookie at all, so a broken session can still be cleared', async () => {
    expect((await signOut('door', '')).status).toBe(204)
  })

  it('succeeds with a garbage cookie rather than erroring', async () => {
    expect((await signOut('door', `es_door_${batchId}=garbage`)).status).toBe(204)
  })

  it('does not clear the other role’s cookie', async () => {
    const officerCookie = cookieFrom(await signIn('officer', 'officer-password-1'))
    const res = await signOut('door', officerCookie)
    expect(res.status).toBe(204)
    expect((await SELF.fetch(`https://example.com/api/batches/${batchId}/officer/ping`, { headers: { cookie: officerCookie } })).status).toBe(200)
  })

  it('audits a real sign-out', async () => {
    const cookie = cookieFrom(await signIn('officer', 'officer-password-1'))
    await signOut('officer', cookie)
    const row = await env.DB.prepare(`SELECT batch_id, role FROM audit_log WHERE action = 'session.officer.signout'`)
      .first<{ batch_id: string; role: string }>()
    expect(row).toEqual({ batch_id: batchId, role: 'officer' })
  })

  it('writes no audit row for a sign-out with no valid session', async () => {
    await signOut('officer', `es_officer_${batchId}=garbage`)
    const { results } = await env.DB.prepare(`SELECT id FROM audit_log WHERE action LIKE '%signout'`).all()
    expect(results).toHaveLength(0)
  })
})

describe('the other-role lookup verifies what the cookie name claims', () => {
  /*
   * When there is no cookie for the requested role, requireRole checks whether
   * the caller holds a session for this batch under a DIFFERENT role, and
   * answers 403 rather than 401 — a door volunteer tapping an officer route is
   * authenticated and simply not authorised, and "sign in again" would send
   * their tablet round a loop it cannot win.
   *
   * The cookie NAME is not covered by the signature, so a hand-forged Cookie
   * header can file any token under any name. These two cases pin that the
   * lookup verifies role and batch on what it finds, instead of treating any
   * verifiable token as proof of a session it never was.
   */

  it('401s when the token under the door cookie name belongs to another batch', async () => {
    const other = await SELF.fetch('https://example.com/api/batches', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-super-admin-key': KEY },
      body: JSON.stringify({
        name: 'O', slug: 'other', officer_password: 'officer-password-2', door_password: 'door-password-2',
        branding: { title: 't', org_name: 'o', accent_color: '#000000', logo_url: '' },
      }),
    })
    const otherId = (await other.json() as { id: string }).id

    // A genuine door session for the OTHER batch, filed under THIS batch's name.
    const token = await signSession(
      { batchId: otherId, role: 'door', exp: Math.floor(Date.now() / 1000) + 3600 }, SECRET)

    const res = await SELF.fetch(`https://example.com/api/batches/${batchId}/officer/ping`, {
      headers: { cookie: `es_door_${batchId}=${token}` },
    })
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: 'unauthenticated', code: 'no_session' })
  })

  it('401s when the token under the door cookie name is actually a voter session', async () => {
    const token = await signSession(
      { batchId, role: 'voter', subject: '2400001', exp: Math.floor(Date.now() / 1000) + 3600 }, SECRET)

    const res = await SELF.fetch(`https://example.com/api/batches/${batchId}/officer/ping`, {
      headers: { cookie: `es_door_${batchId}=${token}` },
    })
    expect(res.status).toBe(401)
  })

  it('still 403s a genuine door session for this batch', async () => {
    const doorRes = await signIn('door', 'door-password-1')
    const cookie = (doorRes.headers.get('set-cookie') ?? '').split(';')[0]!
    const res = await SELF.fetch(`https://example.com/api/batches/${batchId}/officer/ping`, {
      headers: { cookie },
    })
    expect(res.status).toBe(403)
  })
})

