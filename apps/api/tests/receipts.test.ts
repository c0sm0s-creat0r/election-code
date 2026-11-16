import { describe, it, expect, beforeEach } from 'vitest'
import { SELF, env } from 'cloudflare:test'
import { setUp, checkIn, voterSignIn, submitBallot } from './helpers'

let batchId = ''
let doorCookie = ''
let voterCookie = ''
let electionId = ''
let candidateIds: Record<string, string> = {}

beforeEach(async () => {
  const f = await setUp(['2400001'], { seats: 2 })
  ;({ batchId, doorCookie, electionId, candidateIds } = f)
  voterCookie = f.voterCookies['2400001']!
})

const ids = (keys: string[]) => keys.map((k) => candidateIds[k] ?? k)

const submit = (prefs: string[], cookie = voterCookie) =>
  submitBallot(batchId, electionId, cookie, ids(prefs))

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
    // deleting the receipt would let the voter cast again and erase the record
    // that they voted
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
    // the token is still voided; voiding it again must not free a slot
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
    // the receipt row is found through the hash, so a void clears the owner's
    // mark-off, never the caller's
    const mine = await castAndGetToken()
    await checkIn(batchId, doorCookie, '2400002')
    const other = await voterSignIn(batchId, '2400002', 'Turing')
    await submit(['b', 'a'], other)
    // the other voter voids my token, then tries to cast a second ballot
    await voidBallot(mine)
    expect((await submit(['a', 'b'], other)).status).toBe(409)
    const live = await env.DB.prepare('SELECT count(*) c FROM ballot WHERE voided = 0').first<{ c: number }>()
    expect(live!.c).toBe(1)
    // the owner can cast again: their mark-off was cleared
    expect((await submit(['b', 'a'])).status).toBe(201)
  })

  it('records the void in the audit log with no usu_id and no ballot id', async () => {
    const token = await castAndGetToken()
    await voidBallot(token)
    const rows = await env.DB.prepare(`SELECT batch_id, detail FROM audit_log WHERE action = 'ballot.void'`).all<{ batch_id: string | null; detail: string | null }>()
    expect(rows.results).toHaveLength(1)
    expect(rows.results[0]!.detail).toBeNull()
    // attributed to the owning batch
    expect(rows.results[0]!.batch_id).toBe(batchId)
  })

  it('never reveals the voter behind a receipt', async () => {
    const token = await castAndGetToken()
    const text = await (await lookup(token)).text()
    expect(text).not.toMatch(/2400001|Lovelace|Ada/)
  })
})
