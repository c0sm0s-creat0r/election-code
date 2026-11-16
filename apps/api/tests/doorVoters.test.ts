import { describe, it, expect, beforeEach } from 'vitest'
import { SELF, env } from 'cloudflare:test'
import { setUp, submitBallot, voterSignIn, JSON_HEADERS, type Fixture } from './helpers.js'

let f: Fixture

beforeEach(async () => { f = await setUp(['2400001']) })

const NEW_MEMBER = { usu_id: '2400777', first_name: 'Nina', last_name: 'Newjoiner' }

const addVoter = (body: unknown, cookie = f.doorCookie) =>
  SELF.fetch(`https://example.com/api/batches/${f.batchId}/voters`, {
    method: 'POST', headers: { ...JSON_HEADERS, cookie }, body: JSON.stringify(body),
  })

const removeVoter = (usuId: string, cookie = f.doorCookie) =>
  SELF.fetch(`https://example.com/api/batches/${f.batchId}/voters/${usuId}`, {
    method: 'DELETE', headers: { cookie },
  })

const quorum = async () =>
  await (await SELF.fetch(`https://example.com/api/batches/${f.batchId}/quorum`, {
    headers: { cookie: f.doorCookie },
  })).json() as Record<string, number>

describe('adding a member the export missed', () => {
  it('requires a door session', async () => {
    expect((await addVoter(NEW_MEMBER, '')).status).toBe(401)
  })

  it('refuses an officer session', async () => {
    expect((await addVoter(NEW_MEMBER, f.officerCookie)).status).toBe(403)
  })

  it('adds the member and checks them in, in one step', async () => {
    const res = await addVoter(NEW_MEMBER)
    expect(res.status).toBe(201)
    const roll = await env.DB.prepare('SELECT eligible, added_at_door FROM voter_roll WHERE usu_id = ?')
      .bind(NEW_MEMBER.usu_id).first<{ eligible: number; added_at_door: number }>()
    expect(roll).toMatchObject({ eligible: 1, added_at_door: 1 })
    const checkIn = await env.DB.prepare('SELECT count(*) c FROM check_in WHERE usu_id = ?')
      .bind(NEW_MEMBER.usu_id).first<{ c: number }>()
    expect(checkIn!.c).toBe(1)
  })

  it('LETS THEM SIGN IN AND VOTE — the point of the feature', async () => {
    await addVoter(NEW_MEMBER)
    const cookie = await voterSignIn(f.batchId, NEW_MEMBER.usu_id, NEW_MEMBER.last_name)
    expect(cookie).toMatch(/es_voter_/)
    const res = await submitBallot(f.batchId, f.electionId, cookie, [f.candidateIds.a])
    expect(res.status).toBe(201)
  })

  it('REFUSES a usu_id already on the roll, and leaves that member untouched', async () => {
    const res = await addVoter({ usu_id: '2400001', first_name: 'Wrong', last_name: 'Name' })
    expect(res.status).toBe(409)
    const row = await env.DB.prepare('SELECT first_name, added_at_door FROM voter_roll WHERE usu_id = ?')
      .bind('2400001').first<{ first_name: string; added_at_door: number }>()
    expect(row).toMatchObject({ first_name: 'Ada', added_at_door: 0 })
  })

  it('writes no check-in when the usu_id is refused', async () => {
    await env.DB.prepare('DELETE FROM check_in').run()
    await addVoter({ usu_id: '2400001', first_name: 'Wrong', last_name: 'Name' })
    const row = await env.DB.prepare('SELECT count(*) c FROM check_in').first<{ c: number }>()
    expect(row!.c).toBe(0)
  })

  it('rejects a malformed usu_id', async () => {
    for (const usu_id of ['', 'abc', '123', '2400001x', '24007770000']) {
      expect((await addVoter({ ...NEW_MEMBER, usu_id })).status, usu_id).toBe(400)
    }
  })

  it('rejects an empty name', async () => {
    expect((await addVoter({ ...NEW_MEMBER, last_name: '  ' })).status).toBe(400)
  })

  it('counts them in eligible and checked_in, and reports added_at_door beside both', async () => {
    const before = await quorum()
    await addVoter(NEW_MEMBER)
    const after = await quorum()
    expect(after['eligible']).toBe(before['eligible']! + 1)
    expect(after['checked_in']).toBe(before['checked_in']! + 1)
    expect(after['added_at_door']).toBe(1)
  })

  it('removes a mistyped entry', async () => {
    await addVoter(NEW_MEMBER)
    expect((await removeVoter(NEW_MEMBER.usu_id)).status).toBe(204)
    const row = await env.DB.prepare('SELECT count(*) c FROM voter_roll WHERE usu_id = ?')
      .bind(NEW_MEMBER.usu_id).first<{ c: number }>()
    expect(row!.c).toBe(0)
  })

  it('removes their check-in along with the roll row', async () => {
    await addVoter(NEW_MEMBER)
    await removeVoter(NEW_MEMBER.usu_id)
    const row = await env.DB.prepare('SELECT count(*) c FROM check_in WHERE usu_id = ?')
      .bind(NEW_MEMBER.usu_id).first<{ c: number }>()
    expect(row!.c).toBe(0)
  })

  it('REFUSES to remove someone who has voted', async () => {
    await addVoter(NEW_MEMBER)
    const cookie = await voterSignIn(f.batchId, NEW_MEMBER.usu_id, NEW_MEMBER.last_name)
    await submitBallot(f.batchId, f.electionId, cookie, [f.candidateIds.a])
    const res = await removeVoter(NEW_MEMBER.usu_id)
    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({ code: 'already_voted' })
    const row = await env.DB.prepare('SELECT count(*) c FROM voter_roll WHERE usu_id = ?')
      .bind(NEW_MEMBER.usu_id).first<{ c: number }>()
    expect(row!.c).toBe(1)
  })

  it('REFUSES to remove a member who came from the export', async () => {
    const res = await removeVoter('2400001')
    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({ code: 'from_export' })
    const row = await env.DB.prepare('SELECT count(*) c FROM voter_roll WHERE usu_id = ?')
      .bind('2400001').first<{ c: number }>()
    expect(row!.c).toBe(1)
  })

  it('removing an unknown usu_id is not an error', async () => {
    expect((await removeVoter('2400999')).status).toBe(204)
  })

  it('keeps the flag when a corrected export later includes them', async () => {
    await addVoter(NEW_MEMBER)
    // the upsert routes/roll.ts runs
    await env.DB.prepare(
      `INSERT INTO voter_roll (batch_id, usu_id, first_name, last_name, eligible) VALUES (?,?,?,?,1)
       ON CONFLICT(batch_id, usu_id) DO UPDATE SET
         first_name = excluded.first_name, last_name = excluded.last_name, eligible = excluded.eligible`,
    ).bind(f.batchId, NEW_MEMBER.usu_id, 'Nina', 'Newjoiner').run()
    const row = await env.DB.prepare('SELECT added_at_door FROM voter_roll WHERE usu_id = ?')
      .bind(NEW_MEMBER.usu_id).first<{ added_at_door: number }>()
    expect(row!.added_at_door).toBe(1)
  })

  it('cannot add a voter to another batch', async () => {
    const res = await SELF.fetch(`https://example.com/api/batches/${crypto.randomUUID()}/voters`, {
      method: 'POST', headers: { ...JSON_HEADERS, cookie: f.doorCookie },
      body: JSON.stringify(NEW_MEMBER),
    })
    expect(res.status).toBe(401)
    const row = await env.DB.prepare('SELECT count(*) c FROM voter_roll WHERE usu_id = ?')
      .bind(NEW_MEMBER.usu_id).first<{ c: number }>()
    expect(row!.c).toBe(0)
  })

  it('records the action with NO usu_id and NO name', async () => {
    await addVoter(NEW_MEMBER)
    await removeVoter(NEW_MEMBER.usu_id)
    const rows = await env.DB.prepare(`SELECT action, detail FROM audit_log WHERE action LIKE 'voter.%'`)
      .all<{ action: string; detail: string | null }>()
    expect(rows.results.map((r) => r.action).sort()).toEqual(['voter.add_at_door', 'voter.remove_at_door'])
    for (const r of rows.results) expect(r.detail).toBeNull()
    const all = await env.DB.prepare('SELECT * FROM audit_log').all()
    expect(JSON.stringify(all.results)).not.toMatch(/2400777|Newjoiner/)
  })
})
