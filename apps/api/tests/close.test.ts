import { describe, it, expect, beforeEach } from 'vitest'
import { env } from 'cloudflare:test'
import {
  addCandidate, cast, castThree, closeElection, countOf, createElection, openElection,
  setUp, submitBallot, type Fixture,
} from './helpers.js'

let f: Fixture

/** Three ballots in the box: two for Alex, one for Bo. */
beforeEach(async () => {
  f = await setUp()
  await castThree(f)
})

const linked = (electionId = f.electionId) =>
  countOf('vote_receipt', 'election_id = ? AND live_receipt_hash IS NOT NULL', electionId)
const seal = () =>
  env.DB.prepare('SELECT ballot_count, ballots_sha256 FROM election_seal WHERE election_id = ?')
    .bind(f.electionId).first<{ ballot_count: number; ballots_sha256: string }>()

describe('close and seal', () => {
  it('refuses to close a draft election, and 404s one in another batch', async () => {
    const draftId = await createElection(f.batchId, f.officerCookie, 'Secretary', 1)
    await addCandidate(f.batchId, f.officerCookie, draftId, 'Dee')
    expect((await closeElection(f, draftId)).status).toBe(409)
    expect((await closeElection(f, crypto.randomUUID())).status).toBe(404)
  })

  it('closes an open election, seals the box and CLEARS every ballot-to-voter link', async () => {
    // While open, live_receipt_hash joins a usu_id to a ballot. It must not
    // outlive close (HANDOFF §2).
    expect(await linked()).toBe(3)
    expect((await closeElection(f)).status).toBe(200)

    const row = await env.DB.prepare('SELECT status, closed_at FROM election WHERE id = ?')
      .bind(f.electionId).first<{ status: string; closed_at: number }>()
    expect(row!.status).toBe('closed')
    expect(row!.closed_at).toBeGreaterThan(0)
    expect(await seal()).toEqual({ ballot_count: 3, ballots_sha256: expect.stringMatching(/^[0-9a-f]{64}$/) })
    expect(await linked()).toBe(0)
    // the mark-off and the ballots stay
    expect(await countOf('vote_receipt')).toBe(3)
    expect(await countOf('ballot')).toBe(3)
    // and the box takes no more
    expect((await cast(f, '2400001', 'a')).status).toBe(409)
  })

  it('REFUSES A SECOND CLOSE, and never overwrites the seal', async () => {
    await closeElection(f)
    const before = await seal()
    expect((await closeElection(f)).status).toBe(409)
    expect(await seal()).toEqual(before)
  })

  it('seals a closed-but-unsealed election, so the operation is retryable', async () => {
    await env.DB.prepare(`UPDATE election SET status='closed', closed_at=? WHERE id=?`)
      .bind(Date.now(), f.electionId).run()
    expect((await closeElection(f)).status).toBe(200)
    expect(await countOf('election_seal')).toBe(1)
  })

  it('leaves another election\'s links alone when one closes', async () => {
    const otherId = await createElection(f.batchId, f.officerCookie, 'Treasurer', 1)
    const eve = await addCandidate(f.batchId, f.officerCookie, otherId, 'Eve')
    await addCandidate(f.batchId, f.officerCookie, otherId, 'Fred')
    await openElection(f.batchId, f.officerCookie, otherId)
    await submitBallot(f.batchId, otherId, f.voterCookies['2400001']!, [eve])
    await closeElection(f)
    expect(await linked(otherId)).toBe(1)
  })
})
