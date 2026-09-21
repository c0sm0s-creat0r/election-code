/**
 * Plan 2b's cross-cutting success criteria, as assertions over a database that
 * has been through a whole election rather than over the source of one route.
 *
 * Every other test file checks its own route. These checks are the ones that
 * can only fail in combination — an audit row written by one handler carrying
 * an identifier that another handler's purge cannot reach.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { SELF, env, applyD1Migrations } from 'cloudflare:test'
import csv from './fixtures/usu-sample.csv?raw'

const KEY = 'super-secret-test-key'
const json = { 'content-type': 'application/json' }
const cookieOf = (res: Response) => (res.headers.get('set-cookie') ?? '').split(';')[0]!

/** Any 7-digit run: the shape of a USU Net Id. */
const USU_ID_SHAPE = /\d{7}/
/** Any UUID prefix: the shape of a ballot id, a candidate id or a receipt token. */
const UUID_SHAPE = /[0-9a-f]{8}-[0-9a-f]{4}/

beforeEach(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS)
  for (const t of ['ballot', 'vote_receipt', 'candidate', 'election', 'check_in', 'voter_roll', 'audit_log', 'batch']) {
    await env.DB.prepare(`DELETE FROM ${t}`).run()
  }
  for (const k of (await env.RATE_LIMIT.list()).keys) await env.RATE_LIMIT.delete(k.name)
})

/** Provision, import, check in, open, vote, void, recast — the whole path. */
async function runWholeElection() {
  const created = await SELF.fetch('https://example.com/api/batches', {
    method: 'POST', headers: { ...json, 'x-super-admin-key': KEY },
    body: JSON.stringify({
      name: 'N', slug: 's', officer_password: 'officer-password-1', door_password: 'door-password-1',
      branding: { title: 't', org_name: 'o', accent_color: '#000000', logo_url: '' },
    }),
  })
  const batchId = (await created.json() as { id: string }).id

  // a denied super-admin attempt, which audits with a NULL batch
  await SELF.fetch('https://example.com/api/batches', {
    method: 'POST', headers: { ...json, 'x-super-admin-key': 'wrong' }, body: JSON.stringify({}),
  })

  const officerCookie = cookieOf(await SELF.fetch(`https://example.com/api/batches/${batchId}/officer/session`, {
    method: 'POST', headers: json, body: JSON.stringify({ password: 'officer-password-1' }),
  }))
  const doorCookie = cookieOf(await SELF.fetch(`https://example.com/api/batches/${batchId}/door/session`, {
    method: 'POST', headers: json, body: JSON.stringify({ password: 'door-password-1' }),
  }))
  // a failed staff sign-in
  await SELF.fetch(`https://example.com/api/batches/${batchId}/officer/session`, {
    method: 'POST', headers: json, body: JSON.stringify({ password: 'wrong-password-here' }),
  })

  const fd = new FormData()
  fd.append('file', new File([csv], 'members.csv', { type: 'text/csv' }))
  await SELF.fetch(`https://example.com/api/batches/${batchId}/roll`, {
    method: 'POST', headers: { cookie: officerCookie }, body: fd,
  })

  const election = await SELF.fetch(`https://example.com/api/batches/${batchId}/elections`, {
    method: 'POST', headers: { ...json, cookie: officerCookie },
    body: JSON.stringify({ name: 'President', seats: 2 }),
  })
  const electionId = (await election.json() as { id: string }).id
  const candidates: string[] = []
  for (const name of ['Alex', 'Bo', 'Cass']) {
    const res = await SELF.fetch(`https://example.com/api/batches/${batchId}/elections/${electionId}/candidates`, {
      method: 'POST', headers: { ...json, cookie: officerCookie }, body: JSON.stringify({ name }),
    })
    candidates.push((await res.json() as { id: string }).id)
  }
  // a rename and a removal while still in draft
  await SELF.fetch(`https://example.com/api/batches/${batchId}/elections/${electionId}/candidates/${candidates[2]}`, {
    method: 'PATCH', headers: { ...json, cookie: officerCookie }, body: JSON.stringify({ name: 'Cassandra' }),
  })
  await SELF.fetch(`https://example.com/api/batches/${batchId}/elections/${electionId}/open`, {
    method: 'POST', headers: { cookie: officerCookie },
  })

  // two voters through the door, one of them un-checked-in and back again
  for (const usuId of ['2400001', '2400002']) {
    await SELF.fetch(`https://example.com/api/batches/${batchId}/check-in`, {
      method: 'POST', headers: { ...json, cookie: doorCookie }, body: JSON.stringify({ usu_id: usuId }),
    })
  }
  await SELF.fetch(`https://example.com/api/batches/${batchId}/check-in/2400002`, {
    method: 'DELETE', headers: { cookie: doorCookie },
  })
  await SELF.fetch(`https://example.com/api/batches/${batchId}/check-in`, {
    method: 'POST', headers: { ...json, cookie: doorCookie }, body: JSON.stringify({ usu_id: '2400002' }),
  })

  const voters: string[] = []
  for (const [usuId, surname] of [['2400001', 'Lovelace'], ['2400002', 'Turing']] as const) {
    voters.push(cookieOf(await SELF.fetch(`https://example.com/api/batches/${batchId}/voter/session`, {
      method: 'POST', headers: json, body: JSON.stringify({ usu_id: usuId, surname }),
    })))
  }
  // A wrong surname, which deliberately writes NO audit row: this route is
  // limited at 300/10min because CGNAT makes one IP a whole room, so auditing
  // every wrong guess would let an anonymous caller bury the trail.
  await SELF.fetch(`https://example.com/api/batches/${batchId}/voter/session`, {
    method: 'POST', headers: json, body: JSON.stringify({ usu_id: '2400001', surname: 'Wrong' }),
  })
  // A refusal that names a real roll member, which DOES audit: Grace Hopper
  // carries "Left Group" = 1 in the fixture.
  await SELF.fetch(`https://example.com/api/batches/${batchId}/voter/session`, {
    method: 'POST', headers: json, body: JSON.stringify({ usu_id: '2400003', surname: 'Hopper' }),
  })

  const submit = (cookie: string, prefs: string[]) =>
    SELF.fetch(`https://example.com/api/batches/${batchId}/elections/${electionId}/ballots`, {
      method: 'POST', headers: { ...json, cookie }, body: JSON.stringify({ preferences: prefs }),
    })

  const first = (await (await submit(voters[0]!, [candidates[0]!, candidates[1]!])).json() as { receipt_token: string }).receipt_token
  await submit(voters[1]!, [candidates[1]!, candidates[0]!])
  // void and recast
  await SELF.fetch(`https://example.com/api/receipts/${first}/void`, { method: 'POST' })
  await submit(voters[0]!, [candidates[1]!, candidates[0]!])

  return { batchId, electionId }
}

describe('privacy and secret-ballot invariants after a whole election', () => {
  it('no audit_log row contains a USU id or a UUID, in detail OR anywhere else', async () => {
    await runWholeElection()
    const rows = await env.DB.prepare('SELECT role, action, detail FROM audit_log').all<{ role: string; action: string; detail: string | null }>()
    expect(rows.results.length).toBeGreaterThan(10)
    for (const r of rows.results) {
      const text = `${r.action} ${r.detail ?? ''}`
      expect(text, `audit row ${r.action} leaked an identifier`).not.toMatch(USU_ID_SHAPE)
      expect(text, `audit row ${r.action} leaked a UUID`).not.toMatch(UUID_SHAPE)
    }
  })

  it('records every audited action, so the checks above are not passing on an empty table', async () => {
    await runWholeElection()
    const rows = await env.DB.prepare('SELECT DISTINCT action FROM audit_log ORDER BY action').all<{ action: string }>()
    expect(rows.results.map((r) => r.action)).toEqual([
      'ballot.cast',
      'ballot.void',
      'batch.create',
      'batch.create.denied',
      'candidate.add',
      'candidate.update',
      'check_in.add',
      'check_in.remove',
      'election.create',
      'election.open',
      'roll.import',
      'session.door.ok',
      'session.officer.fail',
      'session.officer.ok',
      'session.voter.fail',
      'session.voter.ok',
    ])
  })

  it('stores no email address anywhere in the database', async () => {
    await runWholeElection()
    const tables = ['batch', 'voter_roll', 'check_in', 'election', 'candidate', 'ballot', 'vote_receipt', 'audit_log']
    for (const t of tables) {
      const rows = await env.DB.prepare(`SELECT * FROM ${t}`).all()
      expect(JSON.stringify(rows.results), `${t} carried an email address`).not.toMatch(/@example\.com/)
    }
  })

  it('keeps ballot free of any voter reference or timestamp', async () => {
    await runWholeElection()
    const cols = await env.DB.prepare('PRAGMA table_info(ballot)').all<{ name: string }>()
    expect(cols.results.map((r) => r.name).sort()).toEqual(['election_id', 'id', 'preferences', 'receipt_hash', 'voided'])
  })

  it('keeps ballot WITHOUT ROWID, which is what makes physical order random', async () => {
    const row = await env.DB.prepare(`SELECT sql FROM sqlite_master WHERE name = 'ballot'`).first<{ sql: string }>()
    expect(row!.sql).toMatch(/WITHOUT\s+ROWID/i)
  })

  it('never lets two receipt rows claim one live ballot', async () => {
    await runWholeElection()
    const row = await env.DB
      .prepare(`SELECT count(*) c FROM (
                  SELECT live_receipt_hash FROM vote_receipt
                   WHERE live_receipt_hash IS NOT NULL
                   GROUP BY live_receipt_hash HAVING count(*) > 1)`)
      .first<{ c: number }>()
    expect(row!.c).toBe(0)
  })

  it('leaves the live-ballot link NULL for every voided ballot', async () => {
    await runWholeElection()
    const row = await env.DB
      .prepare(`SELECT count(*) c FROM vote_receipt vr
                  JOIN ballot b ON b.receipt_hash = vr.live_receipt_hash
                 WHERE b.voided = 1`)
      .first<{ c: number }>()
    expect(row!.c).toBe(0)
  })

  it('leaves exactly one live ballot per voter who has voted', async () => {
    await runWholeElection()
    const live = await env.DB.prepare('SELECT count(*) c FROM ballot WHERE voided = 0').first<{ c: number }>()
    const voters = await env.DB.prepare('SELECT count(*) c FROM vote_receipt').first<{ c: number }>()
    expect(live!.c).toBe(voters!.c)
  })
})
