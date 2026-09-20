import { describe, it, expect, beforeEach } from 'vitest'
import { SELF, env, applyD1Migrations } from 'cloudflare:test'

const KEY = 'super-secret-test-key'

beforeEach(async () => {
  // The brief's literal snippet imports the migration as a raw SQL string via
  // `?raw` and passes it to applyD1Migrations; that fails at runtime with
  // "parameter 2 is not of type 'D1Migration[]'" (confirmed when this test was
  // first run). Per the task context notes and tests/schema.test.ts, migrations
  // must go through the TEST_MIGRATIONS binding that vitest.config.ts builds
  // with readD1Migrations() on the Node side.
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS)
  await env.DB.prepare('DELETE FROM audit_log').run()
  await env.DB.prepare('DELETE FROM batch').run()
})

const create = (body: unknown, key?: string) =>
  SELF.fetch('https://example.com/api/batches', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(key ? { 'x-super-admin-key': key } : {}) },
    body: JSON.stringify(body),
  })

const valid = {
  name: 'SciSoc AGM 2026', slug: 'scisoc-2026',
  officer_password: 'officer-pw', door_password: 'door-pw',
  branding: { title: 'Executive Elections', org_name: 'SciSoc', accent_color: '#2563eb', logo_url: '' },
}

describe('POST /api/batches', () => {
  it('refuses without the super admin key', async () => {
    expect((await create(valid)).status).toBe(401)
  })

  it('refuses a wrong super admin key', async () => {
    expect((await create(valid, 'wrong')).status).toBe(401)
  })

  it('creates a batch with the key', async () => {
    const res = await create(valid, KEY)
    expect(res.status).toBe(201)
    const body = await res.json() as { id: string; slug: string }
    expect(body.slug).toBe('scisoc-2026')
    expect(body.id).toMatch(/^[0-9a-f-]{36}$/)
  })

  it('never returns a password or a hash', async () => {
    const text = await (await create(valid, KEY)).text()
    expect(text).not.toContain('officer-pw')
    expect(text).not.toContain('door-pw')
    expect(text).not.toContain('pbkdf2')
  })

  it('stores hashes, not plaintext', async () => {
    await create(valid, KEY)
    const row = await env.DB.prepare('SELECT officer_hash, door_hash FROM batch').first<{ officer_hash: string; door_hash: string }>()
    expect(row!.officer_hash).toMatch(/^pbkdf2-sha256\$/)
    expect(row!.door_hash).toMatch(/^pbkdf2-sha256\$/)
    expect(row!.officer_hash).not.toBe(row!.door_hash)
  })

  it('rejects a duplicate slug', async () => {
    await create(valid, KEY)
    expect((await create(valid, KEY)).status).toBe(409)
  })

  it('rejects a missing field with 400', async () => {
    expect((await create({ name: 'x' }, KEY)).status).toBe(400)
  })

  it('writes an audit_log row', async () => {
    await create(valid, KEY)
    const row = await env.DB.prepare(`SELECT role, action FROM audit_log`).first<{ role: string; action: string }>()
    expect(row).toEqual({ role: 'super', action: 'batch.create' })
  })
})

describe('public batch listing', () => {
  it('returns slug and branding only — never a hash', async () => {
    await create(valid, KEY)
    const res = await SELF.fetch('https://example.com/api/batches')
    expect(res.status).toBe(200)
    const list = await res.json() as Array<Record<string, unknown>>
    expect(list).toHaveLength(1)
    expect(Object.keys(list[0]!).sort()).toEqual(['branding', 'name', 'slug'])
  })

  it('looks a batch up by slug', async () => {
    await create(valid, KEY)
    const res = await SELF.fetch('https://example.com/api/batches/by-slug/scisoc-2026')
    expect(res.status).toBe(200)
    const b = await res.json() as Record<string, unknown>
    expect(Object.keys(b).sort()).toEqual(['branding', 'id', 'name', 'slug'])
  })

  it('404s an unknown slug', async () => {
    expect((await SELF.fetch('https://example.com/api/batches/by-slug/nope')).status).toBe(404)
  })
})
