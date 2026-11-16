import { describe, it, expect, beforeEach } from 'vitest'
import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test'
import worker from '../src/index.js'
import { signSession } from '../src/auth/session.js'
import {
  SESSION_SECRET, api, countOf, createBatch, resetDatabase, signIn, staffSession,
} from './helpers.js'

let batchId = ''

beforeEach(async () => {
  await resetDatabase()
  batchId = await createBatch()
})

const ping = (cookie: string) => api('GET', `/batches/${batchId}/officer/ping`, cookie)
const inAnHour = () => Math.floor(Date.now() / 1000) + 3600

describe('sign-in', () => {
  it('accepts the officer password and sets a hardened, batch-scoped, 8-hour cookie', async () => {
    const res = await staffSession(batchId, 'officer', 'officer-password-1')
    expect(res.status).toBe(200)
    const cookie = res.headers.get('set-cookie') ?? ''
    expect(cookie).toMatch(new RegExp(`^es_officer_${batchId}=`))
    expect(cookie).toMatch(/HttpOnly/i)
    expect(cookie).toMatch(/Secure/i)
    expect(cookie).toMatch(/SameSite=Strict/i)
    expect(cookie).toMatch(/Max-Age=28800\b/i)
    expect(await res.text()).not.toContain('officer-password-1')
  })

  it('accepts the door password and sets a 1-hour cookie', async () => {
    const res = await staffSession(batchId, 'door', 'door-password-1')
    expect(res.status).toBe(200)
    expect(res.headers.get('set-cookie') ?? '').toMatch(/Max-Age=3600\b/i)
  })

  // two passwords: a door volunteer cannot become an officer
  it.each([
    ['officer', 'nope'],
    ['officer', 'door-password-1'],
    ['door', 'officer-password-1'],
  ] as const)('rejects %s sign-in with "%s"', async (role, password) => {
    const res = await staffSession(batchId, role, password)
    expect(res.status).toBe(401)
    expect(res.headers.get('set-cookie')).toBeNull()
  })

  it('refuses an unknown batch without revealing whether it exists', async () => {
    expect([401, 404]).toContain((await staffSession(crypto.randomUUID(), 'officer', 'x')).status)
  })
})

describe('requireRole: what the token must be, whatever the cookie is called', () => {
  // The signature does not cover the cookie name. roleGates.test.ts covers
  // the plain cases for every route.
  it.each<[string, number, (other: string) => Promise<string>]>([
    ['a garbage token', 401, async () => `es_officer_${batchId}=not-a-real-token`],
    ['an expired officer token', 401, async () =>
      `es_officer_${batchId}=${await signSession({ batchId, role: 'officer', exp: Math.floor(Date.now() / 1000) - 1 }, SESSION_SECRET)}`],
    ['an officer token for another batch', 403, async (other) =>
      `es_officer_${batchId}=${await signSession({ batchId: other, role: 'officer', exp: inAnHour() }, SESSION_SECRET)}`],
    ['another batch\'s door token under this batch\'s door cookie', 401, async (other) =>
      `es_door_${batchId}=${await signSession({ batchId: other, role: 'door', exp: inAnHour() }, SESSION_SECRET)}`],
    ['a voter token under the door cookie', 401, async () =>
      `es_door_${batchId}=${await signSession({ batchId, role: 'voter', subject: '2400001', exp: inAnHour() }, SESSION_SECRET)}`],
  ])('%s is a %i', async (_label, status, cookie) => {
    const res = await ping(await cookie(await createBatch('other', 2)))
    expect(res.status).toBe(status)
    const text = await res.text()
    expect(text).not.toContain('pbkdf2')
    expect(text).not.toContain(SESSION_SECRET)
  })
})

describe('sign-out', () => {
  const signOut = (role: 'officer' | 'door', cookie: string) =>
    api('DELETE', `/batches/${batchId}/${role}/session`, cookie)

  it('clears that role\'s cookie, and only that one, and audits it', async () => {
    const res = await signOut('door', await signIn(batchId, 'door', 'door-password-1'))
    expect(res.status).toBe(204)
    const cleared = res.headers.get('set-cookie') ?? ''
    expect(cleared).toMatch(new RegExp(`es_door_${batchId}=`))
    expect(cleared).toMatch(/Max-Age=0\b/i)
    expect(cleared).not.toMatch(/es_officer_/)
    const row = await env.DB.prepare(`SELECT batch_id, role FROM audit_log WHERE action = 'session.door.signout'`)
      .first<{ batch_id: string; role: string }>()
    expect(row).toEqual({ batch_id: batchId, role: 'door' })
  })

  it('succeeds with no session, a garbage one or another role\'s, and audits none of them', async () => {
    const officerCookie = await signIn(batchId, 'officer', 'officer-password-1')
    for (const cookie of ['', `es_door_${batchId}=garbage`, officerCookie]) {
      expect((await signOut('door', cookie)).status).toBe(204)
    }
    expect(await countOf('audit_log', `action LIKE '%signout'`)).toBe(0)
    // the officer session was not the door's to end
    expect((await ping(officerCookie)).status).toBe(200)
  })
})

describe('a misconfigured deployment', () => {
  // `SELF` always uses the configured env, so call the worker directly.
  it('answers 503 to every route when SESSION_SECRET is too short, without naming it', async () => {
    for (const path of ['/api/health', `/api/batches/${batchId}/officer/session`]) {
      const ctx = createExecutionContext()
      const res = await worker.fetch(
        new Request(`https://example.com${path}`), { ...env, SESSION_SECRET: 'too-short' }, ctx)
      await waitOnExecutionContext(ctx)
      expect(res.status).toBe(503)
      const text = await res.text()
      expect(JSON.parse(text)).toEqual({ error: 'server_not_configured' })
      expect(text).not.toMatch(/SESSION_SECRET|too-short/)
    }
  })
})
