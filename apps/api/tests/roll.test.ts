import { describe, it, expect, beforeEach } from 'vitest'
import { SELF, env } from 'cloudflare:test'
// `?raw`, because the workers runtime cannot read the host filesystem.
import csv from './fixtures/usu-sample.csv?raw'
import { setUpBatch, uploadRoll } from './helpers'

let batchId = ''
let officerCookie = ''
let doorCookie = ''

beforeEach(async () => {
  ({ batchId, officerCookie, doorCookie } = await setUpBatch())
})

const upload = (path: string, cookie = officerCookie) => uploadRoll(batchId, cookie, path)

describe('roll import', () => {
  it('requires an officer session', async () => {
    expect((await upload('/roll/preview', '')).status).toBe(401)
  })

  it('rejects a door session', async () => {
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
    // added_at_door (0004) is provenance, not personal data. Nothing else from
    // the export may appear.
    expect(cols.results.map((r) => r.name).sort())
      .toEqual(['added_at_door', 'batch_id', 'eligible', 'first_name', 'last_name', 'usu_id'])
  })

  it('writes no email address anywhere in the database', async () => {
    // the export has one per member; none may be stored
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
    // more rows than one D1 batch() allows, to exercise chunking
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
