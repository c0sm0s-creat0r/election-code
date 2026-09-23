import { describe, it, expect, beforeEach } from 'vitest'
import { SELF, env, applyD1Migrations } from 'cloudflare:test'
import csv from './fixtures/usu-sample.csv?raw'

const KEY = 'super-secret-test-key'
const json = { 'content-type': 'application/json' }

let batchId = ''
let officerCookie = ''
let doorCookie = ''
let voterCookie = ''
let electionId = ''
let draftElectionId = ''
let closedElectionId = ''
let candidateIds: Record<string, string> = {}

const cookieOf = (res: Response) => (res.headers.get('set-cookie') ?? '').split(';')[0]!

const createElection = async (name: string, seats: number) => {
  const res = await SELF.fetch(`https://example.com/api/batches/${batchId}/elections`, {
    method: 'POST', headers: { ...json, cookie: officerCookie },
    body: JSON.stringify({ name, seats }),
  })
  return (await res.json() as { id: string }).id
}

const addCandidate = async (eid: string, name: string) => {
  const res = await SELF.fetch(`https://example.com/api/batches/${batchId}/elections/${eid}/candidates`, {
    method: 'POST', headers: { ...json, cookie: officerCookie },
    body: JSON.stringify({ name }),
  })
  return (await res.json() as { id: string }).id
}

beforeEach(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS)
  for (const t of ['ballot', 'vote_receipt', 'candidate', 'election', 'check_in', 'voter_roll', 'audit_log', 'batch']) {
    await env.DB.prepare(`DELETE FROM ${t}`).run()
  }

  const res = await SELF.fetch('https://example.com/api/batches', {
    method: 'POST',
    headers: { ...json, 'x-super-admin-key': KEY },
    body: JSON.stringify({
      name: 'N', slug: 's', officer_password: 'officer-password-1', door_password: 'door-password-1',
      branding: { title: 't', org_name: 'o', accent_color: '#000000', logo_url: '' },
    }),
  })
  batchId = (await res.json() as { id: string }).id
  officerCookie = cookieOf(await SELF.fetch(`https://example.com/api/batches/${batchId}/officer/session`, {
    method: 'POST', headers: json, body: JSON.stringify({ password: 'officer-password-1' }),
  }))
  doorCookie = cookieOf(await SELF.fetch(`https://example.com/api/batches/${batchId}/door/session`, {
    method: 'POST', headers: json, body: JSON.stringify({ password: 'door-password-1' }),
  }))

  const fd = new FormData()
  fd.append('file', new File([csv], 'members.csv', { type: 'text/csv' }))
  await SELF.fetch(`https://example.com/api/batches/${batchId}/roll`, {
    method: 'POST', headers: { cookie: officerCookie }, body: fd,
  })

  // seats = 2, so the minimum is two preferences
  electionId = await createElection('President', 2)
  candidateIds = {
    a: await addCandidate(electionId, 'Alex'),
    b: await addCandidate(electionId, 'Bo'),
    c: await addCandidate(electionId, 'Cass'),
  }
  await SELF.fetch(`https://example.com/api/batches/${batchId}/elections/${electionId}/open`, {
    method: 'POST', headers: { cookie: officerCookie },
  })

  draftElectionId = await createElection('Secretary', 1)
  await addCandidate(draftElectionId, 'Dee')

  closedElectionId = await createElection('Treasurer', 1)
  await addCandidate(closedElectionId, 'Eve')
  await addCandidate(closedElectionId, 'Fred')
  await SELF.fetch(`https://example.com/api/batches/${batchId}/elections/${closedElectionId}/open`, {
    method: 'POST', headers: { cookie: officerCookie },
  })
  // closing is Plan 2c; for this task the state is what matters
  await env.DB.prepare(`UPDATE election SET status = 'closed', closed_at = ? WHERE id = ?`)
    .bind(Date.now(), closedElectionId).run()

  await SELF.fetch(`https://example.com/api/batches/${batchId}/check-in`, {
    method: 'POST', headers: { ...json, cookie: doorCookie },
    body: JSON.stringify({ usu_id: '2400001' }),
  })
  voterCookie = cookieOf(await SELF.fetch(`https://example.com/api/batches/${batchId}/voter/session`, {
    method: 'POST', headers: json, body: JSON.stringify({ usu_id: '2400001', surname: 'Lovelace' }),
  }))
})

const ids = (keys: string[]) => keys.map((k) => candidateIds[k] ?? k)

const submitTo = (eid: string, prefs: string[], cookie = voterCookie) =>
  SELF.fetch(`https://example.com/api/batches/${batchId}/elections/${eid}/ballots`, {
    method: 'POST', headers: { ...json, cookie },
    body: JSON.stringify({ preferences: ids(prefs) }),
  })

const submit = (prefs: string[], cookie = voterCookie) => submitTo(electionId, prefs, cookie)

describe('ballot submission', () => {
  it('records a ballot and returns a receipt token', async () => {
    const res = await submit(['a', 'b'])
    expect(res.status).toBe(201)
    const body = await res.json() as { receipt_token: string }
    expect(body.receipt_token).toMatch(/^[0-9a-f-]{36}$/)
  })

  it('stores no voter reference and no timestamp on the ballot', async () => {
    await submit(['a', 'b'])
    const cols = await env.DB.prepare('PRAGMA table_info(ballot)').all<{ name: string }>()
    expect(cols.results.map((r) => r.name).sort()).toEqual(['election_id', 'id', 'preferences', 'receipt_hash', 'voided'])
  })

  it('keeps ballot WITHOUT ROWID, so physical order is UUID order', async () => {
    const row = await env.DB.prepare(`SELECT sql FROM sqlite_master WHERE name = 'ballot'`).first<{ sql: string }>()
    expect(row!.sql).toMatch(/WITHOUT\s+ROWID/i)
  })

  it('stores the receipt as a hash, never the token', async () => {
    const token = (await (await submit(['a', 'b'])).json() as { receipt_token: string }).receipt_token
    const row = await env.DB.prepare('SELECT receipt_hash FROM ballot').first<{ receipt_hash: string }>()
    expect(row!.receipt_hash).not.toBe(token)
    expect(row!.receipt_hash).toMatch(/^[0-9a-f]{64}$/)
  })

  it('stores the preferences as the candidate ids in rank order', async () => {
    await submit(['c', 'a'])
    const row = await env.DB.prepare('SELECT preferences FROM ballot').first<{ preferences: string }>()
    expect(JSON.parse(row!.preferences)).toEqual([candidateIds['c'], candidateIds['a']])
  })

  it('REFUSES A SECOND BALLOT from the same voter', async () => {
    await submit(['a', 'b'])
    expect((await submit(['b', 'a'])).status).toBe(409)
  })

  it('leaves exactly one ballot after a refused second submission', async () => {
    await submit(['a', 'b'])
    await submit(['b', 'a'])
    const row = await env.DB.prepare('SELECT count(*) c FROM ballot').first<{ c: number }>()
    expect(row!.c).toBe(1)
  })

  it('refuses two simultaneous submissions, writing exactly one ballot', async () => {
    // the legacy attendee.voted race: two tabs both read "not yet voted"
    const [one, two] = await Promise.all([submit(['a', 'b']), submit(['b', 'a'])])
    expect([one.status, two.status].sort()).toEqual([201, 409])
    const row = await env.DB.prepare('SELECT count(*) c FROM ballot').first<{ c: number }>()
    expect(row!.c).toBe(1)
  })

  it('refuses a voter who was un-checked-in after signing in', async () => {
    // the cookie is still valid; eligibility is not
    await SELF.fetch(`https://example.com/api/batches/${batchId}/check-in/2400001`, {
      method: 'DELETE', headers: { cookie: doorCookie },
    })
    expect((await submit(['a', 'b'])).status).toBe(403)
  })

  it('writes no ballot when eligibility fails', async () => {
    await SELF.fetch(`https://example.com/api/batches/${batchId}/check-in/2400001`, {
      method: 'DELETE', headers: { cookie: doorCookie },
    })
    await submit(['a', 'b'])
    const row = await env.DB.prepare('SELECT count(*) c FROM ballot').first<{ c: number }>()
    expect(row!.c).toBe(0)
  })

  it('writes no receipt when eligibility fails', async () => {
    await SELF.fetch(`https://example.com/api/batches/${batchId}/check-in/2400001`, {
      method: 'DELETE', headers: { cookie: doorCookie },
    })
    await submit(['a', 'b'])
    const row = await env.DB.prepare('SELECT count(*) c FROM vote_receipt').first<{ c: number }>()
    expect(row!.c).toBe(0)
  })

  it('refuses a voter whose roll row was marked ineligible after sign-in', async () => {
    await env.DB.prepare('UPDATE voter_roll SET eligible = 0 WHERE batch_id = ? AND usu_id = ?')
      .bind(batchId, '2400001').run()
    expect((await submit(['a', 'b'])).status).toBe(403)
  })

  it('refuses fewer preferences than seats', async () => {
    // seats = 2 for this fixture
    const res = await submit(['a'])
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ error: expect.stringMatching(/at least 2/) })
  })

  it('refuses an unknown candidate', async () => {
    expect((await submit(['a', 'zzz'])).status).toBe(400)
  })

  it('refuses a candidate belonging to another election', async () => {
    const other = await addCandidate(draftElectionId, 'Ineligible Elsewhere')
    expect((await submit(['a', other])).status).toBe(400)
  })

  it('refuses a duplicated preference', async () => {
    expect((await submit(['a', 'a'])).status).toBe(400)
  })

  it('refuses more preferences than there are candidates', async () => {
    expect((await submit(['a', 'b', 'c', 'a'])).status).toBe(400)
  })

  it('refuses a body that is not a list of strings', async () => {
    const res = await SELF.fetch(`https://example.com/api/batches/${batchId}/elections/${electionId}/ballots`, {
      method: 'POST', headers: { ...json, cookie: voterCookie },
      body: JSON.stringify({ preferences: [1, 2] }),
    })
    expect(res.status).toBe(400)
  })

  it('refuses a ballot in a draft election', async () => {
    expect((await submitTo(draftElectionId, ['a', 'b'])).status).toBe(409)
  })

  it('refuses a ballot in a closed election', async () => {
    expect((await submitTo(closedElectionId, ['a', 'b'])).status).toBe(409)
  })

  it('refuses a ballot in an election that closed after validation', async () => {
    // the transaction's own eligibility clause requires status = 'open', so a
    // close landing between the pre-check and the insert cannot let one through
    await env.DB.prepare(`UPDATE election SET status = 'closed' WHERE id = ?`).bind(electionId).run()
    const res = await submit(['a', 'b'])
    expect([403, 409]).toContain(res.status)
    const row = await env.DB.prepare('SELECT count(*) c FROM ballot').first<{ c: number }>()
    expect(row!.c).toBe(0)
  })

  it('requires a voter session', async () => {
    expect((await submit(['a', 'b'], '')).status).toBe(401)
  })

  it('refuses an officer session', async () => {
    expect((await submit(['a', 'b'], officerCookie)).status).toBe(403)
  })

  it('refuses a door session', async () => {
    expect((await submit(['a', 'b'], doorCookie)).status).toBe(403)
  })

  it('writes an audit row with no usu_id and no ballot id', async () => {
    await submit(['a', 'b'])
    const rows = await env.DB.prepare(`SELECT detail FROM audit_log WHERE action LIKE 'ballot%'`).all<{ detail: string | null }>()
    expect(rows.results.length).toBeGreaterThan(0)
    for (const r of rows.results) {
      expect(r.detail ?? '').not.toMatch(/\d{7}/)
      expect(r.detail ?? '').not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}/)
    }
  })

  it('records the mark-off on the roll, and only that', async () => {
    await submit(['a', 'b'])
    const row = await env.DB.prepare('SELECT usu_id, recast_count FROM vote_receipt').first<{ usu_id: string; recast_count: number }>()
    expect(row).toMatchObject({ usu_id: '2400001', recast_count: 0 })
  })

  it('links the receipt to the live ballot so a void can find the mark-off', async () => {
    const token = (await (await submit(['a', 'b'])).json() as { receipt_token: string }).receipt_token
    const row = await env.DB.prepare('SELECT live_receipt_hash FROM vote_receipt').first<{ live_receipt_hash: string | null }>()
    const ballot = await env.DB.prepare('SELECT receipt_hash FROM ballot').first<{ receipt_hash: string }>()
    expect(row!.live_receipt_hash).toBe(ballot!.receipt_hash)
    expect(row!.live_receipt_hash).not.toBe(token)
  })

  it('lets a different voter cast in the same election', async () => {
    await submit(['a', 'b'])
    await SELF.fetch(`https://example.com/api/batches/${batchId}/check-in`, {
      method: 'POST', headers: { ...json, cookie: doorCookie },
      body: JSON.stringify({ usu_id: '2400002' }),
    })
    const second = cookieOf(await SELF.fetch(`https://example.com/api/batches/${batchId}/voter/session`, {
      method: 'POST', headers: json, body: JSON.stringify({ usu_id: '2400002', surname: 'Turing' }),
    }))
    expect((await submit(['b', 'a'], second)).status).toBe(201)
    const row = await env.DB.prepare('SELECT count(*) c FROM ballot').first<{ c: number }>()
    expect(row!.c).toBe(2)
  })

  it('lets the same voter cast in a second election', async () => {
    await submit(['a', 'b'])
    const eid = await createElection('Vice President', 1)
    await addCandidate(eid, 'Gus')
    const gus = await addCandidate(eid, 'Hana')
    await SELF.fetch(`https://example.com/api/batches/${batchId}/elections/${eid}/open`, {
      method: 'POST', headers: { cookie: officerCookie },
    })
    expect((await submitTo(eid, [gus])).status).toBe(201)
  })

  it('refuses a voter session issued for another batch', async () => {
    const other = await SELF.fetch('https://example.com/api/batches', {
      method: 'POST',
      headers: { ...json, 'x-super-admin-key': KEY },
      body: JSON.stringify({
        name: 'Other', slug: 'other', officer_password: 'officer-password-2', door_password: 'door-password-2',
        branding: { title: 't', org_name: 'o', accent_color: '#000000', logo_url: '' },
      }),
    })
    const otherId = (await other.json() as { id: string }).id
    const res = await SELF.fetch(`https://example.com/api/batches/${otherId}/elections/${electionId}/ballots`, {
      method: 'POST', headers: { ...json, cookie: voterCookie },
      body: JSON.stringify({ preferences: ids(['a', 'b']) }),
    })
    expect(res.status).toBe(401)
    const row = await env.DB.prepare('SELECT count(*) c FROM ballot').first<{ c: number }>()
    expect(row!.c).toBe(0)
  })
})
