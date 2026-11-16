import { describe, it, expect, beforeEach } from 'vitest'
import { SELF, env } from 'cloudflare:test'
import { setUp, submitBallot, createElection, addCandidate, type Fixture } from './helpers.js'

let f: Fixture

beforeEach(async () => {
  f = await setUp(['2400001'])
  await submitBallot(f.batchId, f.electionId, f.voterCookies['2400001']!, [f.candidateIds.a])
})

const close = () =>
  SELF.fetch(`https://example.com/api/batches/${f.batchId}/elections/${f.electionId}/close`, {
    method: 'POST', headers: { cookie: f.officerCookie },
  })

const getResult = () =>
  SELF.fetch(`https://example.com/api/batches/${f.batchId}/elections/${f.electionId}/result`, {
    headers: { cookie: f.officerCookie },
  })

const closeAndCount = async () => { await close(); await getResult() }

const purge = (cookie = f.officerCookie) =>
  SELF.fetch(`https://example.com/api/batches/${f.batchId}/roll`, {
    method: 'DELETE', headers: { cookie },
  })

const countOf = async (table: string) =>
  (await env.DB.prepare(`SELECT count(*) c FROM ${table}`).first<{ c: number }>())!.c

describe('roll purge', () => {
  it('requires an officer session', async () => {
    expect((await purge('')).status).toBe(401)
  })

  it('refuses a door session', async () => {
    expect((await purge(f.doorCookie)).status).toBe(403)
  })

  it('REFUSES while an election is still open', async () => {
    expect((await purge()).status).toBe(409)
    expect(await countOf('voter_roll')).toBeGreaterThan(0)
  })

  it('refuses while an election is still in draft', async () => {
    await close()
    const laterId = await createElection(f.batchId, f.officerCookie, 'Later', 1)
    await addCandidate(f.batchId, f.officerCookie, laterId, 'Dee')
    expect((await purge()).status).toBe(409)
    expect(await countOf('voter_roll')).toBeGreaterThan(0)
  })

  it('says how many elections are still open', async () => {
    const body = await (await purge()).json() as { error: string; remaining: number }
    expect(body.remaining).toBe(1)
    expect(body.error).toMatch(/1/)
  })

  it('purges the roll and check-ins once every election is closed', async () => {
    await close()
    const res = await purge()
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ voter_roll: 6, check_in: 1 })
    expect(await countOf('voter_roll')).toBe(0)
    expect(await countOf('check_in')).toBe(0)
  })

  it('KEEPS the ballots, the seal and the result', async () => {
    await closeAndCount()
    await purge()
    for (const table of ['ballot', 'election_seal', 'election_result']) {
      expect(await countOf(table), table).toBeGreaterThan(0)
    }
  })

  it('keeps vote_receipt, because it is the mark-off on the roll', async () => {
    await closeAndCount()
    await purge()
    expect(await countOf('vote_receipt')).toBeGreaterThan(0)
  })

  it('leaves the result still readable and unchanged', async () => {
    await closeAndCount()
    const before = await (await getResult()).text()
    await purge()
    expect(await (await getResult()).text()).toBe(before)
  })

  it('leaves the ballot export still verifiable against the seal', async () => {
    // the count was sealed against the ballots, not the roll
    await closeAndCount()
    const before = await (await SELF.fetch(
      `https://example.com/api/batches/${f.batchId}/elections/${f.electionId}/ballots.csv`,
      { headers: { cookie: f.officerCookie } },
    )).text()
    await purge()
    const after = await (await SELF.fetch(
      `https://example.com/api/batches/${f.batchId}/elections/${f.electionId}/ballots.csv`,
      { headers: { cookie: f.officerCookie } },
    )).text()
    expect(after).toBe(before)
  })

  it('does not touch another batch\'s roll', async () => {
    await close()
    const otherBatch = await (await SELF.fetch('https://example.com/api/batches', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-super-admin-key': 'super-secret-test-key' },
      body: JSON.stringify({
        name: 'Other', slug: 'other', officer_password: 'officer-password-2', door_password: 'door-password-2',
        branding: { title: 't', org_name: 'o', accent_color: '#000000', logo_url: '' },
      }),
    })).json() as { id: string }
    await env.DB.prepare('INSERT INTO voter_roll (batch_id, usu_id, first_name, last_name, eligible) VALUES (?,?,?,?,1)')
      .bind(otherBatch.id, '2400009', 'Someone', 'Else').run()
    await purge()
    const row = await env.DB.prepare('SELECT count(*) c FROM voter_roll WHERE batch_id = ?')
      .bind(otherBatch.id).first<{ c: number }>()
    expect(row!.c).toBe(1)
  })

  it('is idempotent', async () => {
    await close()
    await purge()
    const res = await purge()
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ voter_roll: 0, check_in: 0 })
  })

  it('records an audit row with row counts and no identities', async () => {
    await close()
    await purge()
    const row = await env.DB.prepare(`SELECT detail FROM audit_log WHERE action = 'roll.purge'`)
      .first<{ detail: string }>()
    expect(JSON.parse(row!.detail)).toMatchObject({ kind: 'roll_purge', rowsDeleted: 7 })
    expect(row!.detail).not.toMatch(/\d{7}/)
  })

  it('PURGES GUESTS — a guest name is personal data', async () => {
    await SELF.fetch(`https://example.com/api/batches/${f.batchId}/guests`, {
      method: 'POST', headers: { 'content-type': 'application/json', cookie: f.doorCookie },
      body: JSON.stringify({ name: 'Jo Visitor' }),
    })
    await close()
    const res = await purge()
    expect(await res.json()).toMatchObject({ guest: 1 })
    expect(await countOf('guest')).toBe(0)
  })

  it('purges a door-added member like any other roll row', async () => {
    await SELF.fetch(`https://example.com/api/batches/${f.batchId}/voters`, {
      method: 'POST', headers: { 'content-type': 'application/json', cookie: f.doorCookie },
      body: JSON.stringify({ usu_id: '2400777', first_name: 'Nina', last_name: 'Newjoiner' }),
    })
    await close()
    await purge()
    expect(await countOf('voter_roll')).toBe(0)
  })

  it('leaves no live ballot link behind for a purged voter', async () => {
    await close()
    await purge()
    const row = await env.DB
      .prepare('SELECT count(*) c FROM vote_receipt WHERE live_receipt_hash IS NOT NULL')
      .first<{ c: number }>()
    expect(row!.c).toBe(0)
  })
})
