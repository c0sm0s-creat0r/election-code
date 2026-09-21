import { describe, it, expect, beforeEach } from 'vitest'
import { SELF, env, applyD1Migrations } from 'cloudflare:test'

const KEY = 'super-secret-test-key'
const body = (slug: string) => JSON.stringify({
  name: 'N', slug, officer_password: 'officer-password-1', door_password: 'door-password-1',
  branding: { title: 't', org_name: 'o', accent_color: '#000000', logo_url: '' },
})

beforeEach(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS)
  await env.DB.prepare('DELETE FROM batch').run()
  await env.DB.prepare('DELETE FROM audit_log').run()
  for (const k of (await env.RATE_LIMIT.list()).keys) await env.RATE_LIMIT.delete(k.name)
})

const create = (slug: string, ip = '203.0.113.1') =>
  SELF.fetch('https://example.com/api/batches', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-super-admin-key': KEY, 'cf-connecting-ip': ip },
    body: body(slug),
  })

describe('rate limiting', () => {
  it('allows requests under the limit', async () => {
    expect((await create('a')).status).toBe(201)
    expect((await create('b')).status).toBe(201)
  })

  it('returns 429 once the limit is exceeded', async () => {
    for (let i = 0; i < 10; i++) await create(`s${i}`)
    const res = await create('over-the-limit')
    expect(res.status).toBe(429)
    expect(await res.json()).toMatchObject({ error: 'rate_limited' })
  })

  it('sets Retry-After on a 429', async () => {
    for (let i = 0; i < 10; i++) await create(`t${i}`)
    const res = await create('t-over')
    expect(Number(res.headers.get('retry-after'))).toBeGreaterThan(0)
  })

  it('counts per IP, so one blocked client does not block another', async () => {
    for (let i = 0; i < 10; i++) await create(`u${i}`, '203.0.113.1')
    expect((await create('u-over', '203.0.113.1')).status).toBe(429)
    expect((await create('other-ip', '198.51.100.7')).status).toBe(201)
  })

  it('limits the sign-in route separately from batch creation', async () => {
    // exhausting one must not exhaust the other
    for (let i = 0; i < 10; i++) await create(`v${i}`)
    const res = await SELF.fetch('https://example.com/api/batches/nope/officer/session', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.1' },
      body: JSON.stringify({ password: 'x' }),
    })
    expect(res.status).not.toBe(429)
  })

  it('rejects before doing the expensive work', async () => {
    // a 429 on sign-in must not have run PBKDF2 or written an audit row
    for (let i = 0; i < 30; i++) {
      await SELF.fetch('https://example.com/api/batches/nope/officer/session', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'cf-connecting-ip': '198.51.100.9' },
        body: JSON.stringify({ password: 'x' }),
      })
    }
    const before = await env.DB.prepare(`SELECT count(*) c FROM audit_log`).first<{ c: number }>()
    const res = await SELF.fetch('https://example.com/api/batches/nope/officer/session', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'cf-connecting-ip': '198.51.100.9' },
      body: JSON.stringify({ password: 'x' }),
    })
    expect(res.status).toBe(429)
    const after = await env.DB.prepare(`SELECT count(*) c FROM audit_log`).first<{ c: number }>()
    expect(after!.c).toBe(before!.c)
  })

  it('limits the door sign-in route too', async () => {
    // spec §6 and HANDOFF §6b(3): both staff sign-ins are unauthenticated,
    // cost ~210k PBKDF2 iterations, and write an audit row per failure.
    for (let i = 0; i < 30; i++) {
      await SELF.fetch('https://example.com/api/batches/nope/door/session', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'cf-connecting-ip': '198.51.100.11' },
        body: JSON.stringify({ password: 'x' }),
      })
    }
    const res = await SELF.fetch('https://example.com/api/batches/nope/door/session', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'cf-connecting-ip': '198.51.100.11' },
      body: JSON.stringify({ password: 'x' }),
    })
    expect(res.status).toBe(429)
  })

  it('falls back to x-forwarded-for when cf-connecting-ip is absent', async () => {
    for (let i = 0; i < 10; i++) {
      await SELF.fetch('https://example.com/api/batches', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-super-admin-key': KEY, 'x-forwarded-for': '192.0.2.5, 70.41.3.18' },
        body: body(`xff${i}`),
      })
    }
    const res = await SELF.fetch('https://example.com/api/batches', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-super-admin-key': KEY, 'x-forwarded-for': '192.0.2.5, 70.41.3.18' },
      body: body('xff-over'),
    })
    expect(res.status).toBe(429)
  })
})
