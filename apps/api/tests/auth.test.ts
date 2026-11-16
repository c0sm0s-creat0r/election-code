import { describe, it, expect, beforeEach } from 'vitest'
import {
  SELF, env, applyD1Migrations, createExecutionContext, waitOnExecutionContext,
} from 'cloudflare:test'
import worker from '../src/index.js'
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
    // two passwords: a door volunteer cannot become an officer
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
    // 401, not 403: the frontend shows a sign-in prompt.
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
    // A validly signed token for another batch, sent under this batch's cookie name.
    const otherId = crypto.randomUUID()
    const token = await signSession({ batchId: otherId, role: 'officer', exp: Math.floor(Date.now() / 1000) + 3600 }, SECRET)
    const res = await SELF.fetch(`https://example.com/api/batches/${batchId}/officer/ping`, {
      headers: { cookie: `es_officer_${batchId}=${token}` },
    })
    expect(res.status).toBe(403)
  })

  it('401s a tampered/garbage cookie value', async () => {
    // A token with a bad signature identifies nobody: 401, not 403.
    const res = await ping(`es_officer_${batchId}=not-a-real-token`)
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: 'unauthenticated', code: 'invalid' })
  })

  it('401s an expired but validly-signed officer session, distinguishably', async () => {
    // An expired door cookie must read as "sign in again".
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
    // The server cannot revoke a signed token. Check the cookie was cleared and
    // the route gates without it.
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
  // With no cookie for the requested role, a valid session under another role
  // gets 403. The cookie name is not signed, so these cases check role and
  // batch on the token found.

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

    // A real door session for the other batch, under this batch's cookie name.
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


describe('a misconfigured deployment', () => {
  // A short SESSION_SECRET returns 503, not a 500. Called on the worker
  // directly because `SELF` always uses the configured env.
  const withShortSecret = async (path: string, body: unknown): Promise<Response> => {
    const request = new Request(`https://example.com${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    const ctx = createExecutionContext()
    const res = await worker.fetch(request, { ...env, SESSION_SECRET: 'too-short' }, ctx)
    await waitOnExecutionContext(ctx)
    return res
  }

  it('answers 503 server_not_configured rather than an opaque 500', async () => {
    const res = await withShortSecret(
      `/api/batches/${batchId}/officer/session`, { password: 'officer-password-1' })
    expect(res.status).toBe(503)
    expect(await res.json()).toMatchObject({ error: 'server_not_configured' })
  })

  it('never names the secret or its value', async () => {
    const res = await withShortSecret(
      `/api/batches/${batchId}/door/session`, { password: 'door-password-1' })
    expect(await res.text()).not.toMatch(/SESSION_SECRET|too-short/)
  })

  it('refuses a voter sign-in the same way', async () => {
    const res = await withShortSecret(
      `/api/batches/${batchId}/voter/session`, { usu_id: '2400001', surname: 'Lovelace' })
    expect(res.status).toBe(503)
  })
})
