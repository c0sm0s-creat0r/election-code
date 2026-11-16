import { describe, it, expect, beforeEach } from 'vitest'
import { env } from 'cloudflare:test'
import {
  addCandidate, api, checkIn, countOf, createBatch, createElection, openElection,
  setUp, submitBallot, tokenOf, voterSignIn, type Fixture,
} from './helpers.js'

let f: Fixture
let voterCookie = ''
let draftElectionId = ''

// seats = 2, so the minimum is two preferences
beforeEach(async () => {
  f = await setUp(['2400001'], { seats: 2, candidates: ['Alex', 'Bo', 'Cass'] })
  voterCookie = f.voterCookies['2400001']!
  draftElectionId = await createElection(f.batchId, f.officerCookie, 'Secretary', 1)
})

const ids = (keys: string[]) => keys.map((k) => f.candidateIds[k] ?? k)
const submit = (prefs: string[], cookie = voterCookie, electionId = f.electionId) =>
  submitBallot(f.batchId, electionId, cookie, ids(prefs))

const receipt = () =>
  env.DB.prepare('SELECT usu_id, recast_count, live_receipt_hash FROM vote_receipt')
    .first<{ usu_id: string; recast_count: number; live_receipt_hash: string | null }>()

describe('ballot submission', () => {
  it('records the preferences in rank order and returns a receipt token', async () => {
    const res = await submit(['c', 'a'])
    expect(res.status).toBe(201)
    expect(await tokenOf(res)).toMatch(/^[0-9a-f-]{36}$/)
    const row = await env.DB.prepare('SELECT preferences FROM ballot').first<{ preferences: string }>()
    expect(JSON.parse(row!.preferences)).toEqual(ids(['c', 'a']))
  })

  it('stores the receipt as a hash, never the token, and marks the voter off against it', async () => {
    const token = await tokenOf(await submit(['a', 'b']))
    const ballot = await env.DB.prepare('SELECT receipt_hash FROM ballot').first<{ receipt_hash: string }>()
    expect(ballot!.receipt_hash).toMatch(/^[0-9a-f]{64}$/)
    expect(ballot!.receipt_hash).not.toBe(token)
    // the link a void uses to find the mark-off
    expect(await receipt()).toEqual({ usu_id: '2400001', recast_count: 0, live_receipt_hash: ballot!.receipt_hash })
  })

  it('REFUSES A SECOND BALLOT from the same voter, leaving exactly one', async () => {
    await submit(['a', 'b'])
    expect((await submit(['b', 'a'])).status).toBe(409)
    expect(await countOf('ballot')).toBe(1)
  })

  it('refuses two simultaneous submissions, writing exactly one ballot', async () => {
    // the legacy attendee.voted race: two tabs both read "not yet voted"
    const [one, two] = await Promise.all([submit(['a', 'b']), submit(['b', 'a'])])
    expect([one.status, two.status].sort()).toEqual([201, 409])
    expect(await countOf('ballot')).toBe(1)
  })

  // the cookie is still valid; eligibility is not
  it.each<[string, number[], () => Promise<unknown>]>([
    ['un-checked-in', [403], () => api('DELETE', `/batches/${f.batchId}/check-in/2400001`, f.doorCookie)],
    ['marked ineligible', [403], () =>
      env.DB.prepare('UPDATE voter_roll SET eligible = 0 WHERE usu_id = ?').bind('2400001').run()],
    // the insert's own clause requires status = 'open', so a close between
    // the pre-check and the insert blocks the ballot
    ['in an election that has just closed', [403, 409], () =>
      env.DB.prepare(`UPDATE election SET status = 'closed' WHERE id = ?`).bind(f.electionId).run()],
  ])('refuses a voter %s after signing in, writing no ballot and no receipt', async (_label, statuses, change) => {
    await change()
    expect(statuses).toContain((await submit(['a', 'b'])).status)
    expect(await countOf('ballot')).toBe(0)
    expect(await countOf('vote_receipt')).toBe(0)
  })

  it('refuses fewer preferences than seats, naming the minimum', async () => {
    const res = await submit(['a'])
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ error: expect.stringMatching(/at least 2/) })
  })

  it.each<[string, () => Promise<unknown> | unknown]>([
    ['an unknown candidate', () => ids(['a', 'zzz'])],
    ['a candidate belonging to another election', async () =>
      [f.candidateIds.a, await addCandidate(f.batchId, f.officerCookie, draftElectionId, 'Elsewhere')]],
    ['a duplicated preference', () => ids(['a', 'a'])],
    ['more preferences than there are candidates', () => ids(['a', 'b', 'c', 'a'])],
    ['preferences that are not strings', () => [1, 2]],
  ])('refuses %s', async (_label, preferences) => {
    expect((await submitBallot(f.batchId, f.electionId, voterCookie, await preferences())).status).toBe(400)
    expect(await countOf('ballot')).toBe(0)
  })

  it('refuses a ballot in a draft election', async () => {
    const dee = await addCandidate(f.batchId, f.officerCookie, draftElectionId, 'Dee')
    expect((await submitBallot(f.batchId, draftElectionId, voterCookie, [dee])).status).toBe(409)
  })

  it('lets a different voter cast in the same election', async () => {
    await submit(['a', 'b'])
    await checkIn(f.batchId, f.doorCookie, '2400002')
    const second = await voterSignIn(f.batchId, '2400002', 'Turing')
    expect((await submit(['b', 'a'], second)).status).toBe(201)
    expect(await countOf('ballot')).toBe(2)
  })

  it('lets the same voter cast in a second election', async () => {
    await submit(['a', 'b'])
    const dee = await addCandidate(f.batchId, f.officerCookie, draftElectionId, 'Dee')
    await openElection(f.batchId, f.officerCookie, draftElectionId)
    expect((await submitBallot(f.batchId, draftElectionId, voterCookie, [dee])).status).toBe(201)
  })

  it('refuses a voter session issued for another batch', async () => {
    const otherId = await createBatch('other', 2)
    expect((await submitBallot(otherId, f.electionId, voterCookie, ids(['a', 'b']))).status).toBe(401)
    expect(await countOf('ballot')).toBe(0)
  })
})
