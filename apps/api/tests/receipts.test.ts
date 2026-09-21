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
let candidateIds: Record<string, string> = {}

const cookieOf = (res: Response) => (res.headers.get('set-cookie') ?? '').split(';')[0]!

const addCandidate = async (eid: string, name: string) => {
  const res = await SELF.fetch(`https://example.com/api/batches/${batchId}/elections/${eid}/candidates`, {
    method: 'POST', headers: { ...json, cookie: officerCookie }, body: JSON.stringify({ name }),
  })
  return (await res.json() as { id: string }).id
}

beforeEach(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS)
  for (const t of ['ballot', 'vote_receipt', 'candidate', 'election', 'check_in', 'voter_roll', 'audit_log', 'batch']) {
    await env.DB.prepare(`DELETE FROM ${t}`).run()
  }
  for (const k of (await env.RATE_LIMIT.list()).keys) await env.RATE_LIMIT.delete(k.name)

  const res = await SELF.fetch('https://example.com/api/batches', {
    method: 'POST', headers: { ...json, 'x-super-admin-key': KEY },
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

  const created = await SELF.fetch(`https://example.com/api/batches/${batchId}/elections`, {
    method: 'POST', headers: { ...json, cookie: officerCookie },
    body: JSON.stringify({ name: 'President', seats: 2 }),
  })
  electionId = (await created.json() as { id: string }).id
  candidateIds = {
    a: await addCandidate(electionId, 'Alex'),
    b: await addCandidate(electionId, 'Bo'),
  }
  await SELF.fetch(`https://example.com/api/batches/${batchId}/elections/${electionId}/open`, {
    method: 'POST', headers: { cookie: officerCookie },
  })

  await SELF.fetch(`https://example.com/api/batches/${batchId}/check-in`, {
    method: 'POST', headers: { ...json, cookie: doorCookie }, body: JSON.stringify({ usu_id: '2400001' }),
  })
  voterCookie = cookieOf(await SELF.fetch(`https://example.com/api/batches/${batchId}/voter/session`, {
    method: 'POST', headers: json, body: JSON.stringify({ usu_id: '2400001', surname: 'Lovelace' }),
  }))
})

const ids = (keys: string[]) => keys.map((k) => candidateIds[k] ?? k)

const submit = (prefs: string[], cookie = voterCookie) =>
  SELF.fetch(`https://example.com/api/batches/${batchId}/elections/${electionId}/ballots`, {
    method: 'POST', headers: { ...json, cookie },
    body: JSON.stringify({ preferences: ids(prefs) }),
  })

const castAndGetToken = async () =>
  (await (await submit(['a', 'b'])).json() as { receipt_token: string }).receipt_token

const lookup = (token: string) => SELF.fetch(`https://example.com/api/receipts/${token}`)
const voidBallot = (token: string) =>
  SELF.fetch(`https://example.com/api/receipts/${token}/void`, { method: 'POST' })

const closeElection = () =>
  env.DB.prepare(`UPDATE election SET status = 'closed', closed_at = ? WHERE id = ?`)
    .bind(Date.now(), electionId).run()

describe('receipts', () => {
  it('confirms a ballot is recorded', async () => {
    const token = await castAndGetToken()
    const res = await lookup(token)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ status: 'recorded', election_name: 'President' })
  })

  it('NEVER returns the preferences', async () => {
    const token = await castAndGetToken()
    const text = await (await lookup(token)).text()
    expect(text).not.toMatch(/preferences/)
    for (const id of Object.values(candidateIds)) expect(text).not.toContain(id)
  })

  it('never returns a candidate name either', async () => {
    const token = await castAndGetToken()
    const text = await (await lookup(token)).text()
    expect(text).not.toMatch(/Alex|Bo/)
  })

  it('404s an unknown token', async () => {
    expect((await lookup(crypto.randomUUID())).status).toBe(404)
  })

  it('does not accept the stored hash in place of the token', async () => {
    await castAndGetToken()
    const row = await env.DB.prepare('SELECT receipt_hash FROM ballot').first<{ receipt_hash: string }>()
    expect((await lookup(row!.receipt_hash)).status).toBe(404)
  })

  it('voids a ballot while the election is open', async () => {
    const token = await castAndGetToken()
    const res = await voidBallot(token)
    expect(res.status).toBe(200)
    const row = await env.DB.prepare('SELECT voided FROM ballot').first<{ voided: number }>()
    expect(row!.voided).toBe(1)
  })

  it('keeps the voided ballot row, so the seal still covers it', async () => {
    const token = await castAndGetToken()
    await voidBallot(token)
    const row = await env.DB.prepare('SELECT count(*) c FROM ballot').first<{ c: number }>()
    expect(row!.c).toBe(1)
  })

  it('keeps the mark-off on the roll after a void', async () => {
    // deleting the receipt would let the voter cast again AND erase the record
    // that they had voted at all
    const token = await castAndGetToken()
    await voidBallot(token)
    const row = await env.DB.prepare('SELECT usu_id FROM vote_receipt').first<{ usu_id: string }>()
    expect(row!.usu_id).toBe('2400001')
  })

  it('clears the live-ballot link on a void', async () => {
    const token = await castAndGetToken()
    await voidBallot(token)
    const row = await env.DB.prepare('SELECT live_receipt_hash FROM vote_receipt').first<{ live_receipt_hash: string | null }>()
    expect(row!.live_receipt_hash).toBeNull()
  })

  it('lets the voter cast again after voiding', async () => {
    const token = await castAndGetToken()
    await voidBallot(token)
    expect((await submit(['b', 'a'])).status).toBe(201)
    const row = await env.DB.prepare('SELECT recast_count FROM vote_receipt').first<{ recast_count: number }>()
    expect(row!.recast_count).toBe(1)
  })

  it('leaves two ballot rows after a recast, exactly one of them live', async () => {
    const token = await castAndGetToken()
    await voidBallot(token)
    await submit(['b', 'a'])
    const total = await env.DB.prepare('SELECT count(*) c FROM ballot').first<{ c: number }>()
    const live = await env.DB.prepare('SELECT count(*) c FROM ballot WHERE voided = 0').first<{ c: number }>()
    expect(total!.c).toBe(2)
    expect(live!.c).toBe(1)
  })

  it('issues a NEW token on a recast, and the old one stays voided', async () => {
    const first = await castAndGetToken()
    await voidBallot(first)
    const second = (await (await submit(['b', 'a'])).json() as { receipt_token: string }).receipt_token
    expect(second).not.toBe(first)
    expect(await (await lookup(first)).json()).toMatchObject({ status: 'voided' })
    expect(await (await lookup(second)).json()).toMatchObject({ status: 'recorded' })
  })

  it('refuses a THIRD ballot after one void and one recast', async () => {
    const first = await castAndGetToken()
    await voidBallot(first)
    await submit(['b', 'a'])
    expect((await submit(['a', 'b'])).status).toBe(409)
    const live = await env.DB.prepare('SELECT count(*) c FROM ballot WHERE voided = 0').first<{ c: number }>()
    expect(live!.c).toBe(1)
  })

  it('cannot replay a voided token to cast an extra ballot', async () => {
    const first = await castAndGetToken()
    await voidBallot(first)
    await submit(['b', 'a'])
    // the voided token is still voided; voiding it again must not free a slot
    expect((await voidBallot(first)).status).toBe(409)
    const live = await env.DB.prepare('SELECT count(*) c FROM ballot WHERE voided = 0').first<{ c: number }>()
    expect(live!.c).toBe(1)
  })

  it('reports a voided ballot as voided', async () => {
    const token = await castAndGetToken()
    await voidBallot(token)
    expect(await (await lookup(token)).json()).toMatchObject({ status: 'voided' })
  })

  it('refuses to void once the election is closed', async () => {
    const token = await castAndGetToken()
    await closeElection()
    expect((await voidBallot(token)).status).toBe(409)
  })

  it('leaves the ballot live when a void is refused for a closed election', async () => {
    const token = await castAndGetToken()
    await closeElection()
    await voidBallot(token)
    const row = await env.DB.prepare('SELECT voided FROM ballot').first<{ voided: number }>()
    expect(row!.voided).toBe(0)
  })

  it('refuses to void the same ballot twice', async () => {
    const token = await castAndGetToken()
    await voidBallot(token)
    expect((await voidBallot(token)).status).toBe(409)
  })

  it('does not increment recast_count on a refused second void', async () => {
    const token = await castAndGetToken()
    await voidBallot(token)
    await voidBallot(token)
    const row = await env.DB.prepare('SELECT recast_count FROM vote_receipt').first<{ recast_count: number }>()
    expect(row!.recast_count).toBe(1)
  })

  it('404s a void for an unknown token', async () => {
    expect((await voidBallot(crypto.randomUUID())).status).toBe(404)
  })

  it('voiding one voter\'s ballot cannot free another voter to cast twice', async () => {
    // the receipt row is found THROUGH the hash, so a void always clears the
    // true owner's mark-off -- never the caller's
    const mine = await castAndGetToken()
    await SELF.fetch(`https://example.com/api/batches/${batchId}/check-in`, {
      method: 'POST', headers: { ...json, cookie: doorCookie }, body: JSON.stringify({ usu_id: '2400002' }),
    })
    const other = cookieOf(await SELF.fetch(`https://example.com/api/batches/${batchId}/voter/session`, {
      method: 'POST', headers: json, body: JSON.stringify({ usu_id: '2400002', surname: 'Turing' }),
    }))
    await submit(['b', 'a'], other)
    // the other voter voids MY token, then tries to cast a second ballot
    await voidBallot(mine)
    expect((await submit(['a', 'b'], other)).status).toBe(409)
    const live = await env.DB.prepare('SELECT count(*) c FROM ballot WHERE voided = 0').first<{ c: number }>()
    expect(live!.c).toBe(1)
    // and the true owner can cast again, because their own mark-off was cleared
    expect((await submit(['b', 'a'])).status).toBe(201)
  })

  it('records the void in the audit log with no usu_id and no ballot id', async () => {
    const token = await castAndGetToken()
    await voidBallot(token)
    const rows = await env.DB.prepare(`SELECT batch_id, detail FROM audit_log WHERE action = 'ballot.void'`).all<{ batch_id: string | null; detail: string | null }>()
    expect(rows.results).toHaveLength(1)
    expect(rows.results[0]!.detail).toBeNull()
    // attributed to the owning batch, so the void shows up in that batch's
    // audit export rather than only in a global one
    expect(rows.results[0]!.batch_id).toBe(batchId)
  })

  it('never reveals the voter behind a receipt', async () => {
    const token = await castAndGetToken()
    const text = await (await lookup(token)).text()
    expect(text).not.toMatch(/2400001|Lovelace|Ada/)
  })
})
