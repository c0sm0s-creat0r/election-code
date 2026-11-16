import { describe, it, expect, beforeEach } from 'vitest'
import { SELF, env } from 'cloudflare:test'
import {
  JSON_HEADERS, setUp, createBatch, createElection, addCandidate, openElection,
  checkIn, voterSignIn, submitBallot,
} from './helpers'

let batchId = ''
let officerCookie = ''
let doorCookie = ''
let voterCookie = ''
let electionId = ''
let draftElectionId = ''
let closedElectionId = ''
let candidateIds: Record<string, string> = {}

beforeEach(async () => {
  // seats = 2, so the minimum is two preferences
  const f = await setUp(['2400001'], { seats: 2, candidates: ['Alex', 'Bo', 'Cass'] })
  ;({ batchId, officerCookie, doorCookie, electionId, candidateIds } = f)
  voterCookie = f.voterCookies['2400001']!

  draftElectionId = await createElection(batchId, officerCookie, 'Secretary', 1)
  await addCandidate(batchId, officerCookie, draftElectionId, 'Dee')

  closedElectionId = await createElection(batchId, officerCookie, 'Treasurer', 1)
  await addCandidate(batchId, officerCookie, closedElectionId, 'Eve')
  await addCandidate(batchId, officerCookie, closedElectionId, 'Fred')
  await openElection(batchId, officerCookie, closedElectionId)
  // set directly; close.test.ts covers the route
  await env.DB.prepare(`UPDATE election SET status = 'closed', closed_at = ? WHERE id = ?`)
    .bind(Date.now(), closedElectionId).run()
})

const ids = (keys: string[]) => keys.map((k) => candidateIds[k] ?? k)

const submitTo = (eid: string, prefs: string[], cookie = voterCookie) =>
  submitBallot(batchId, eid, cookie, ids(prefs))

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
    const other = await addCandidate(batchId, officerCookie, draftElectionId, 'Ineligible Elsewhere')
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
      method: 'POST', headers: { ...JSON_HEADERS, cookie: voterCookie },
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
    // the insert's eligibility clause requires status = 'open', so a close
    // between the pre-check and the insert blocks the ballot
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
    await checkIn(batchId, doorCookie, '2400002')
    const second = await voterSignIn(batchId, '2400002', 'Turing')
    expect((await submit(['b', 'a'], second)).status).toBe(201)
    const row = await env.DB.prepare('SELECT count(*) c FROM ballot').first<{ c: number }>()
    expect(row!.c).toBe(2)
  })

  it('lets the same voter cast in a second election', async () => {
    await submit(['a', 'b'])
    const eid = await createElection(batchId, officerCookie, 'Vice President', 1)
    await addCandidate(batchId, officerCookie, eid, 'Gus')
    const gus = await addCandidate(batchId, officerCookie, eid, 'Hana')
    await openElection(batchId, officerCookie, eid)
    expect((await submitTo(eid, [gus])).status).toBe(201)
  })

  it('refuses a voter session issued for another batch', async () => {
    const otherId = await createBatch('other', 2)
    const res = await submitBallot(otherId, electionId, voterCookie, ids(['a', 'b']))
    expect(res.status).toBe(401)
    const row = await env.DB.prepare('SELECT count(*) c FROM ballot').first<{ c: number }>()
    expect(row!.c).toBe(0)
  })
})
