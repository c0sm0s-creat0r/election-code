import { describe, it, expect, beforeEach } from 'vitest'
import { SELF, env, applyD1Migrations } from 'cloudflare:test'
import { signSession } from '../src/auth/session.js'

const KEY = 'super-secret-test-key'
const SECRET = 'test-secret-value'
let batchId = ''

beforeEach(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS)
  await env.DB.prepare('DELETE FROM audit_log').run()
  await env.DB.prepare('DELETE FROM batch').run()
  const res = await SELF.fetch('https://example.com/api/batches', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-super-admin-key': KEY },
    body: JSON.stringify({
      name: 'N', slug: 's', officer_password: 'officer-pw', door_password: 'door-pw',
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
    const res = await signIn('officer', 'officer-pw')
    expect(res.status).toBe(200)
    const cookie = res.headers.get('set-cookie') ?? ''
    expect(cookie).toMatch(/HttpOnly/i)
    expect(cookie).toMatch(/Secure/i)
    expect(cookie).toMatch(/SameSite=Strict/i)
  })

  it('accepts the door password', async () => {
    expect((await signIn('door', 'door-pw')).status).toBe(200)
  })

  it('rejects a wrong password', async () => {
    expect((await signIn('officer', 'nope')).status).toBe(401)
  })

  it('does NOT accept the door password on the officer route', async () => {
    // the whole point of two passwords: a door volunteer cannot become an officer
    expect((await signIn('officer', 'door-pw')).status).toBe(401)
  })

  it('does NOT accept the officer password on the door route', async () => {
    expect((await signIn('door', 'officer-pw')).status).toBe(401)
  })

  it('never echoes the password', async () => {
    expect(await (await signIn('officer', 'officer-pw')).text()).not.toContain('officer-pw')
  })

  it('404s an unknown batch without revealing whether it exists', async () => {
    const res = await SELF.fetch(`https://example.com/api/batches/${crypto.randomUUID()}/officer/session`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'x' }),
    })
    expect([401, 404]).toContain(res.status)
  })

  it('writes an audit row on success and on failure', async () => {
    await signIn('officer', 'officer-pw')
    await signIn('officer', 'wrong')
    const rows = await env.DB.prepare(`SELECT action FROM audit_log WHERE action LIKE 'session%'`).all<{ action: string }>()
    expect(rows.results.map(r => r.action).sort()).toEqual(['session.officer.fail', 'session.officer.ok'])
  })

  it('sets the officer cookie max-age to 8 hours', async () => {
    const cookie = (await signIn('officer', 'officer-pw')).headers.get('set-cookie') ?? ''
    expect(cookie).toMatch(/Max-Age=28800\b/i)
  })

  it('sets the door cookie max-age to 1 hour', async () => {
    const cookie = (await signIn('door', 'door-pw')).headers.get('set-cookie') ?? ''
    expect(cookie).toMatch(/Max-Age=3600\b/i)
  })

  it('scopes the officer cookie name to this batch and role', async () => {
    const cookie = (await signIn('officer', 'officer-pw')).headers.get('set-cookie') ?? ''
    expect(cookie).toMatch(new RegExp(`es_officer_${batchId}=`))
  })
})

describe('requireRole middleware (via the officer test-seam route)', () => {
  const ping = (cookie: string, id: string = batchId) =>
    SELF.fetch(`https://example.com/api/batches/${id}/officer/ping`, {
      headers: cookie ? { cookie } : {},
    })

  it('allows an officer session through', async () => {
    const setCookie = (await signIn('officer', 'officer-pw')).headers.get('set-cookie') ?? ''
    const cookie = (setCookie.split(';')[0]) ?? ''
    const res = await ping(cookie)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
  })

  it('rejects with no session cookie at all', async () => {
    expect((await ping('')).status).toBe(403)
  })

  it('rejects a door session on an officer-gated route: a door volunteer must never become an officer', async () => {
    const setCookie = (await signIn('door', 'door-pw')).headers.get('set-cookie') ?? ''
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

  it('rejects a tampered/garbage cookie value', async () => {
    const res = await ping(`es_officer_${batchId}=not-a-real-token`)
    expect(res.status).toBe(403)
  })
})
