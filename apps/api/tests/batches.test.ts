import { describe, it, expect, beforeEach } from 'vitest'
import { env } from 'cloudflare:test'
import { SUPER_KEY, api, batchBody, countOf, postBatch, resetDatabase } from './helpers.js'

beforeEach(resetDatabase)

const valid = batchBody('scisoc-2026')

const auditRows = async () =>
  (await env.DB.prepare('SELECT batch_id, role, action, detail FROM audit_log').all()).results

describe('creating a society', () => {
  it('needs no key: societies sign themselves up, audited as public', async () => {
    const res = await postBatch(valid)
    expect(res.status).toBe(201)
    const body = await res.json() as { id: string; slug: string }
    expect(body.slug).toBe('scisoc-2026')
    expect(body.id).toMatch(/^[0-9a-f-]{36}$/)
    // exactly one row, and no denial: no key was offered
    expect(await auditRows()).toEqual([{ batch_id: body.id, role: 'public', action: 'batch.create', detail: null }])
  })

  it('records a create with the operator key as an operator action', async () => {
    expect((await postBatch(valid, SUPER_KEY)).status).toBe(201)
    expect(await auditRows()).toMatchObject([{ role: 'super', action: 'batch.create' }])
  })

  it('stores password hashes and never returns a password or a hash', async () => {
    const text = await (await postBatch(valid)).text()
    for (const secret of ['officer-password-1', 'door-password-1', 'pbkdf2']) expect(text).not.toContain(secret)
    const row = await env.DB.prepare('SELECT officer_hash, door_hash FROM batch')
      .first<{ officer_hash: string; door_hash: string }>()
    expect(row!.officer_hash).toMatch(/^pbkdf2-sha256\$/)
    expect(row!.door_hash).toMatch(/^pbkdf2-sha256\$/)
    expect(row!.officer_hash).not.toBe(row!.door_hash)
  })

  it('refuses a WRONG key, because presenting one is an operator attempt, and audits it without the key', async () => {
    // A near-miss guess in `detail` would be a credential in a readable table.
    const guess = 'super-secret-test-kex'
    expect((await postBatch(valid, guess)).status).toBe(401)
    expect(await countOf('batch')).toBe(0)
    // batch_id is NULL: no batch exists to attribute the attempt to.
    const rows = await auditRows()
    expect(rows).toEqual([{ batch_id: null, role: 'super', action: 'batch.create.denied', detail: null }])
    expect(JSON.stringify((await env.DB.prepare('SELECT * FROM audit_log').all()).results)).not.toContain(guess.slice(0, 6))
  })

  it('refuses a slug already taken, leaving no second audit row', async () => {
    await postBatch(valid)
    expect((await postBatch(valid)).status).toBe(409)
    expect(await auditRows()).toHaveLength(1)
  })
})

describe('validation', () => {
  const branding = (over: Record<string, string>) => ({ branding: { ...valid.branding, ...over } })

  it.each<[string, Record<string, unknown>]>([
    ['a missing field', { slug: undefined }],
    ['a slug with a path separator', { slug: 'scisoc/2026' }],
    ['a slug with ..', { slug: '../etc' }],
    ['an uppercase or spaced slug', { slug: 'SciSoc 2026' }],
    ['a non-hex accent_color', branding({ accent_color: 'blue' })],
    ['a javascript: logo_url', branding({ logo_url: 'javascript:alert(1)' })],
    ['a data: logo_url', branding({ logo_url: 'data:image/png;base64,AAAA' })],
    ['a non-https logo_url', branding({ logo_url: 'http://insecure.example/logo.png' })],
    // scheme-relative: browsers resolve it off-origin
    ['a protocol-relative logo_url', branding({ logo_url: '//evil.com/logo.png' })],
    // some browsers treat a leading backslash as a slash
    ['a backslash-prefixed logo_url', branding({ logo_url: '/\\evil.com' })],
    ['a one-character door password', { door_password: 'x' }],
    ['a 5-character officer password', { officer_password: 'short' }],
    ['the same password for both roles', { officer_password: 'same-password-1', door_password: 'same-password-1' }],
  ])('rejects %s', async (_label, over) => {
    const res = await postBatch({ ...valid, ...over })
    expect(res.status).toBe(400)
    // The 400 body is a fixed literal. Nothing the caller typed is reflected.
    expect(await res.text()).not.toContain('short')
    expect(await countOf('batch')).toBe(0)
  })

  it('REFUSES RESERVED SLUGS, so no society can call itself admin or official', async () => {
    for (const slug of ['new', 'api', 'admin', 'official', 'receipt', 'door']) {
      expect((await postBatch({ ...valid, slug })).status, slug).toBe(400)
    }
  })

  it('accepts 6-character passwords and an https or root-relative logo_url', async () => {
    const short = { officer_password: 'a'.repeat(6), door_password: 'b'.repeat(6) }
    expect((await postBatch({ ...valid, ...short, ...branding({ logo_url: 'https://example.com/logo.png' }) })).status).toBe(201)
    expect((await postBatch({ ...valid, slug: 'other', ...branding({ logo_url: '/logo.png' }) })).status).toBe(201)
  })
})

describe('public batch listing', () => {
  it('lists slug, name and branding only: never a hash', async () => {
    await postBatch(valid)
    const list = await (await api('GET', '/batches')).json() as Array<Record<string, unknown>>
    expect(list).toHaveLength(1)
    expect(Object.keys(list[0]!).sort()).toEqual(['branding', 'name', 'slug'])
  })

  it('looks a batch up by slug, and 404s an unknown one', async () => {
    await postBatch(valid)
    const res = await api('GET', '/batches/by-slug/scisoc-2026')
    expect(res.status).toBe(200)
    expect(Object.keys(await res.json() as object).sort()).toEqual(['branding', 'id', 'name', 'slug'])
    expect((await api('GET', '/batches/by-slug/nope')).status).toBe(404)
  })
})
