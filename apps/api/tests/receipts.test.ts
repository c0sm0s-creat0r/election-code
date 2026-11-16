import { describe, it, expect, beforeEach } from 'vitest'
import { env } from 'cloudflare:test'
import {
  api, cast, checkIn, closeElection, countOf, setUp, submitBallot, tokenOf, voterSignIn, type Fixture,
} from './helpers.js'

let f: Fixture

beforeEach(async () => { f = await setUp(['2400001'], { seats: 2 }) })

const castAndGetToken = async (...keys: string[]) => tokenOf(await cast(f, '2400001', ...(keys.length ? keys : ['a', 'b'])))
const lookup = (token: string) => api('GET', `/receipts/${token}`)
const voidBallot = (token: string) => api('POST', `/receipts/${token}/void`)
const statusOf = async (token: string) => (await (await lookup(token)).json() as { status: string }).status
const live = () => countOf('ballot', 'voided = 0')
const receipt = () =>
  env.DB.prepare('SELECT usu_id, recast_count, live_receipt_hash FROM vote_receipt')
    .first<{ usu_id: string; recast_count: number; live_receipt_hash: string | null }>()

describe('receipts', () => {
  it('confirms a ballot is recorded, and NOTHING about how or by whom', async () => {
    const res = await lookup(await castAndGetToken())
    expect(res.status).toBe(200)
    const text = await res.text()
    expect(JSON.parse(text)).toEqual({ status: 'recorded', election_name: 'President' })
    expect(text).not.toMatch(/preferences|Alex|Bo|2400001|Lovelace|Ada/)
    for (const id of Object.values(f.candidateIds)) expect(text).not.toContain(id)
  })

  it('404s an unknown token, and the stored hash in place of the token', async () => {
    await castAndGetToken()
    const row = await env.DB.prepare('SELECT receipt_hash FROM ballot').first<{ receipt_hash: string }>()
    for (const token of [crypto.randomUUID(), row!.receipt_hash]) {
      expect((await lookup(token)).status).toBe(404)
      expect((await voidBallot(token)).status).toBe(404)
    }
    expect(await live()).toBe(1)
  })

  it('voids a ballot while the election is open, keeping the row and the mark-off', async () => {
    const token = await castAndGetToken()
    expect((await voidBallot(token)).status).toBe(200)
    expect(await statusOf(token)).toBe('voided')
    // the row stays, so the seal still covers it
    expect(await countOf('ballot')).toBe(1)
    expect(await live()).toBe(0)
    // Deleting the receipt would erase the record that they voted. Only the
    // live-ballot link is cleared.
    expect(await receipt()).toEqual({ usu_id: '2400001', recast_count: 1, live_receipt_hash: null })
  })

  it('lets the voter cast ONCE more after voiding, under a new token', async () => {
    const first = await castAndGetToken()
    await voidBallot(first)
    const res = await cast(f, '2400001', 'b', 'a')
    expect(res.status).toBe(201)
    const second = await tokenOf(res)
    expect(second).not.toBe(first)
    expect(await statusOf(first)).toBe('voided')
    expect(await statusOf(second)).toBe('recorded')
    expect(await countOf('ballot')).toBe(2)

    // a third ballot is refused, and replaying the voided token frees no slot
    expect((await cast(f, '2400001', 'a', 'b')).status).toBe(409)
    expect((await voidBallot(first)).status).toBe(409)
    expect((await cast(f, '2400001', 'a', 'b')).status).toBe(409)
    expect(await live()).toBe(1)
    expect((await receipt())!.recast_count).toBe(1)
  })

  it('refuses to void the same ballot twice, without counting a second recast', async () => {
    const token = await castAndGetToken()
    await voidBallot(token)
    expect((await voidBallot(token)).status).toBe(409)
    expect((await receipt())!.recast_count).toBe(1)
  })

  it('refuses to void once the election is closed, leaving the ballot live', async () => {
    const token = await castAndGetToken()
    await closeElection(f)
    expect((await voidBallot(token)).status).toBe(409)
    expect(await live()).toBe(1)
  })

  it('voiding one voter\'s ballot cannot free another voter to cast twice', async () => {
    // the receipt row is found through the hash, so a void clears the owner's
    // mark-off, never the caller's
    const mine = await castAndGetToken()
    await checkIn(f.batchId, f.doorCookie, '2400002')
    const other = await voterSignIn(f.batchId, '2400002', 'Turing')
    const theirs = () => submitBallot(f.batchId, f.electionId, other, [f.candidateIds.b, f.candidateIds.a])
    await theirs()
    // the other voter voids my token, then tries to cast a second ballot
    await voidBallot(mine)
    expect((await theirs()).status).toBe(409)
    expect(await live()).toBe(1)
    // the owner can cast again: their mark-off was cleared
    expect((await cast(f, '2400001', 'b', 'a')).status).toBe(201)
  })
})
