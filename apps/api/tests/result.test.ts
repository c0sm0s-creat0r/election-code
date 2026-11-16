import { describe, it, expect, beforeEach } from 'vitest'
import { env } from 'cloudflare:test'
import {
  addCandidate, cast, castThree, closeElection, countOf, createElection, getResult,
  setUp, voidLiveBallot, type Fixture,
} from './helpers.js'

let f: Fixture

/** Three ballots, one seat: Alex 2, Bo 1. Quota = floor(3/2)+1 = 2. */
beforeEach(async () => {
  f = await setUp()
  await castThree(f)
})

type Result = {
  quota: string; winners: { id: string }[]; rounds: unknown[]
  ballots_sha256: string; ballot_count: number
  tie_breaks: { id: string; kind: string; method: string; seed: string | null }[]
}
const seal = () =>
  env.DB.prepare('SELECT ballot_count, ballots_sha256 FROM election_seal')
    .first<{ ballot_count: number; ballots_sha256: string }>()

describe('result', () => {
  it('REFUSES a result while the election is open or in draft, and counts nothing', async () => {
    expect((await getResult(f)).status).toBe(409)
    const draftId = await createElection(f.batchId, f.officerCookie, 'Secretary', 1)
    await addCandidate(f.batchId, f.officerCookie, draftId, 'Dee')
    expect((await getResult(f, draftId)).status).toBe(409)
    expect(await countOf('election_result')).toBe(0)
  })

  it('returns the count once closed, with the seal and no ballot or voter id', async () => {
    await closeElection(f)
    const res = await getResult(f)
    expect(res.status).toBe(200)
    const text = await res.text()
    const body = JSON.parse(text) as Result
    expect(body.quota).toBe('2.00000')
    expect(body.winners.map((w) => w.id)).toEqual([f.candidateIds.a])
    expect(body.rounds.length).toBeGreaterThan(0)
    // the seal travels with the count
    expect({ ballot_count: body.ballot_count, ballots_sha256: body.ballots_sha256 }).toEqual(await seal())
    // Checked against the real ids, not a 7-digit shape: `computed_at` and
    // `closed_at` are 13 digits.
    for (const usuId of Object.keys(f.voterCookies)) expect(text).not.toContain(usuId)
    const ballots = await env.DB.prepare('SELECT id FROM ballot').all<{ id: string }>()
    for (const b of ballots.results) expect(text).not.toContain(b.id)
  })

  it('stores the result rather than recomputing it, and serves it byte-identically', async () => {
    await closeElection(f)
    expect(await (await getResult(f)).text()).toBe(await (await getResult(f)).text())
    expect(await countOf('election_result', 'election_id = ?', f.electionId)).toBe(1)
  })

  it('EXCLUDES voided ballots from the count but keeps them in the seal', async () => {
    await voidLiveBallot('2400004')
    await closeElection(f)
    expect((await seal())!.ballot_count).toBe(3)
    const body = await (await getResult(f)).json() as Result
    // 2 counted ballots, 1 seat -> floor(2/2)+1 = 2
    expect(body.quota).toBe('2.00000')
    expect(body.winners[0]!.id).toBe(f.candidateIds.a)
  })

  it('reports a tie-break with its kind and method, seeded from the seal but not with it', async () => {
    // one each: an exclusion tie the count must resolve by draw
    const tied = await setUp(['2400001', '2400002'])
    await cast(tied, '2400001', 'a', 'b')
    await cast(tied, '2400002', 'b', 'a')
    await closeElection(tied)
    const { tie_breaks } = await (await getResult(tied)).json() as Result
    expect(tie_breaks).toMatchObject([{ id: 'tb-1', kind: 'exclusion', method: 'seeded_draw' }])
    expect(tie_breaks[0]!.seed).toBeTruthy()
    expect(tie_breaks[0]!.seed).not.toBe((await seal())!.ballots_sha256)
  })

  it('404s a result for an election that is not this batch\'s', async () => {
    await closeElection(f)
    expect((await getResult(f, crypto.randomUUID())).status).toBe(404)
  })
})
