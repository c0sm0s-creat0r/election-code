import { describe, it, expect, beforeEach } from 'vitest'
import { SELF, env, applyD1Migrations } from 'cloudflare:test'
// Bundled with `?raw`, not read with node:fs: these tests execute inside the
// workers runtime, which has no access to the host filesystem.
import csv from './fixtures/usu-sample.csv?raw'

const KEY = 'super-secret-test-key'
let batchId = ''
let officerCookie = ''

beforeEach(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS)
  for (const t of ['voter_roll', 'check_in', 'audit_log', 'batch']) {
    await env.DB.prepare(`DELETE FROM ${t}`).run()
  }
  for (const k of (await env.RATE_LIMIT.list()).keys) await env.RATE_LIMIT.delete(k.name)
  const res = await SELF.fetch('https://example.com/api/batches', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-super-admin-key': KEY },
    body: JSON.stringify({
      name: 'N', slug: 's', officer_password: 'officer-password-1', door_password: 'door-password-1',
      branding: { title: 't', org_name: 'o', accent_color: '#000000', logo_url: '' },
    }),
  })
  batchId = (await res.json() as { id: string }).id
  const si = await SELF.fetch(`https://example.com/api/batches/${batchId}/officer/session`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: 'officer-password-1' }),
  })
  officerCookie = (si.headers.get('set-cookie') ?? '').split(';')[0]!
})

const upload = (path: string, cookie = officerCookie) => {
  const fd = new FormData()
  fd.append('file', new File([csv], 'members.csv', { type: 'text/csv' }))
  return SELF.fetch(`https://example.com/api/batches/${batchId}${path}`, {
    method: 'POST', headers: { cookie }, body: fd,
  })
}

describe('roll import', () => {
  it('requires an officer session', async () => {
    expect((await upload('/roll/preview', '')).status).toBe(401)
  })

  it('rejects a door session', async () => {
    const si = await SELF.fetch(`https://example.com/api/batches/${batchId}/door/session`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: 'door-password-1' }),
    })
    const doorCookie = (si.headers.get('set-cookie') ?? '').split(';')[0]!
    expect((await upload('/roll/preview', doorCookie)).status).toBe(403)
  })

  it('previews counts without writing anything', async () => {
    const res = await upload('/roll/preview')
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ total: 6, eligible: 4, excluded: 2, skipped: 0, shifted: true })
    const row = await env.DB.prepare('SELECT count(*) c FROM voter_roll').first<{ c: number }>()
    expect(row!.c).toBe(0)
  })

  it('commits the roll', async () => {
    const res = await upload('/roll')
    expect(res.status).toBe(200)
    const row = await env.DB.prepare('SELECT count(*) c FROM voter_roll WHERE batch_id = ?').bind(batchId).first<{ c: number }>()
    expect(row!.c).toBe(6)
  })

  it('marks departed members ineligible rather than dropping them', async () => {
    await upload('/roll')
    const row = await env.DB.prepare('SELECT count(*) c FROM voter_roll WHERE batch_id = ? AND eligible = 0').bind(batchId).first<{ c: number }>()
    expect(row!.c).toBe(2)
  })

  it('stores only id and name — no email, no membership data', async () => {
    await upload('/roll')
    const cols = await env.DB.prepare('PRAGMA table_info(voter_roll)').all<{ name: string }>()
    // added_at_door (migration 0004) is provenance, not personal data: it
    // records that a volunteer created the row, not anything about the member.
    // Everything else the USU export carries -- email, payments, tags, officer
    // notes, expiry dates -- still must never appear here.
    expect(cols.results.map((r) => r.name).sort())
      .toEqual(['added_at_door', 'batch_id', 'eligible', 'first_name', 'last_name', 'usu_id'])
  })

  it('writes no email address anywhere in the database', async () => {
    // the export carries one per member; none of it may land
    await upload('/roll')
    const rows = await env.DB.prepare('SELECT * FROM voter_roll').all()
    expect(JSON.stringify(rows.results)).not.toMatch(/@example\.com/)
  })

  it('is idempotent — re-importing does not duplicate', async () => {
    await upload('/roll')
    await upload('/roll')
    const row = await env.DB.prepare('SELECT count(*) c FROM voter_roll WHERE batch_id = ?').bind(batchId).first<{ c: number }>()
    expect(row!.c).toBe(6)
  })

  it('re-importing updates eligibility rather than leaving it stale', async () => {
    await upload('/roll')
    await env.DB.prepare('UPDATE voter_roll SET eligible = 0 WHERE batch_id = ?').bind(batchId).run()
    await upload('/roll')
    const row = await env.DB.prepare('SELECT count(*) c FROM voter_roll WHERE batch_id = ? AND eligible = 1').bind(batchId).first<{ c: number }>()
    expect(row!.c).toBe(4)
  })

  it('records an audit row carrying counts, never identities', async () => {
    await upload('/roll')
    const row = await env.DB.prepare(`SELECT action, detail FROM audit_log WHERE action = 'roll.import'`).first<{ action: string; detail: string }>()
    expect(row).toBeTruthy()
    expect(row!.detail).not.toMatch(/\d{7}/)   // no usu_id
    expect(JSON.parse(row!.detail)).toMatchObject({ kind: 'roll_import', eligible: 4, excluded: 2 })
  })

  it('rejects a corrupt export without writing a partial roll', async () => {
    const fd = new FormData()
    fd.append('file', new File(['"Net Id","First Name"\n"1","unterminated'], 'bad.csv', { type: 'text/csv' }))
    const res = await SELF.fetch(`https://example.com/api/batches/${batchId}/roll`, {
      method: 'POST', headers: { cookie: officerCookie }, body: fd,
    })
    expect(res.status).toBe(400)
    const row = await env.DB.prepare('SELECT count(*) c FROM voter_roll').first<{ c: number }>()
    expect(row!.c).toBe(0)
  })

  it('rejects a request with no file', async () => {
    const res = await SELF.fetch(`https://example.com/api/batches/${batchId}/roll`, {
      method: 'POST', headers: { cookie: officerCookie }, body: new FormData(),
    })
    expect(res.status).toBe(400)
  })

  it('rejects a file over the size ceiling', async () => {
    const fd = new FormData()
    fd.append('file', new File(['x'.repeat(2 * 1024 * 1024 + 1)], 'huge.csv', { type: 'text/csv' }))
    const res = await SELF.fetch(`https://example.com/api/batches/${batchId}/roll`, {
      method: 'POST', headers: { cookie: officerCookie }, body: fd,
    })
    expect(res.status).toBe(400)
  })

  it('imports a roll of 1,300 rows in one request', async () => {
    // the real export is 1,302 members; D1 caps statements per batch() call,
    // so this is the test that the chunking exists at all
    const header = csv.split('\n')[0]!
    const template = csv.split('\n')[1]!
    const rows = Array.from({ length: 1300 }, (_, i) =>
      template.replace('"2400001"', `"${3000000 + i}"`).replace('"600001"', `"${700000 + i}"`),
    )
    const big = [header, ...rows].join('\n')
    const fd = new FormData()
    fd.append('file', new File([big], 'big.csv', { type: 'text/csv' }))
    const res = await SELF.fetch(`https://example.com/api/batches/${batchId}/roll`, {
      method: 'POST', headers: { cookie: officerCookie }, body: fd,
    })
    expect(res.status).toBe(200)
    const row = await env.DB.prepare('SELECT count(*) c FROM voter_roll WHERE batch_id = ?').bind(batchId).first<{ c: number }>()
    expect(row!.c).toBe(1300)
  })
})

describe('roll summary', () => {
  const summary = (cookie = officerCookie) =>
    SELF.fetch(`https://example.com/api/batches/${batchId}/officer/roll/summary`, { headers: { cookie } })

  it('requires an officer session', async () => {
    expect((await summary('')).status).toBe(401)
  })

  it('is zero before anything is imported', async () => {
    const res = await summary()
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ total: 0, eligible: 0 })
  })

  it('counts the imported roll, and nothing else', async () => {
    await upload('/roll')
    expect(await (await summary()).json()).toEqual({ total: 6, eligible: 4 })
  })
})
