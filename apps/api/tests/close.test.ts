import { describe, it, expect, beforeEach } from 'vitest'
import { SELF, env } from 'cloudflare:test'
import {
  setUp, submitBallot, createElection, addCandidate, sha256Hex, type Fixture,
} from './helpers.js'

let f: Fixture

/** Three ballots in the box: two for Alex, one for Bo. */
beforeEach(async () => {
  f = await setUp()
  const { a, b } = f.candidateIds
  await submitBallot(f.batchId, f.electionId, f.voterCookies['2400001']!, [a, b])
  await submitBallot(f.batchId, f.electionId, f.voterCookies['2400002']!, [a, b])
  await submitBallot(f.batchId, f.electionId, f.voterCookies['2400004']!, [b, a])
})

const close = (cookie = f.officerCookie, electionId = f.electionId) =>
  SELF.fetch(`https://example.com/api/batches/${f.batchId}/elections/${electionId}/close`, {
    method: 'POST', headers: { cookie },
  })

/** Void the first voter's ballot, via the receipt they were handed. */
const voidOneBallot = async () => {
  const hash = await env.DB
    .prepare('SELECT live_receipt_hash FROM vote_receipt WHERE usu_id = ?')
    .bind('2400001').first<{ live_receipt_hash: string }>()
  // the test holds the hash, not the token, so void directly — the route is
  // covered by receipts.test.ts
  await env.DB.prepare('UPDATE ballot SET voided = 1 WHERE receipt_hash = ?').bind(hash!.live_receipt_hash).run()
  await env.DB.prepare('UPDATE vote_receipt SET live_receipt_hash = NULL WHERE usu_id = ?').bind('2400001').run()
}

describe('close and seal', () => {
  it('requires an officer session', async () => {
    expect((await close('')).status).toBe(401)
  })

  it('refuses a door session', async () => {
    expect((await close(f.doorCookie)).status).toBe(403)
  })

  it('refuses to close a draft election', async () => {
    const draftId = await createElection(f.batchId, f.officerCookie, 'Secretary', 1)
    await addCandidate(f.batchId, f.officerCookie, draftId, 'Dee')
    expect((await close(f.officerCookie, draftId)).status).toBe(409)
  })

  it('404s an election in another batch', async () => {
    expect((await close(f.officerCookie, crypto.randomUUID())).status).toBe(404)
  })

  it('closes an open election', async () => {
    const res = await close()
    expect(res.status).toBe(200)
    const row = await env.DB.prepare('SELECT status, closed_at FROM election WHERE id = ?')
      .bind(f.electionId).first<{ status: string; closed_at: number }>()
    expect(row!.status).toBe('closed')
    expect(row!.closed_at).toBeGreaterThan(0)
  })

  it('writes a seal recording the ballot count and digest', async () => {
    await close()
    const row = await env.DB.prepare('SELECT ballot_count, ballots_sha256 FROM election_seal WHERE election_id = ?')
      .bind(f.electionId).first<{ ballot_count: number; ballots_sha256: string }>()
    expect(row!.ballot_count).toBe(3)
    expect(row!.ballots_sha256).toMatch(/^[0-9a-f]{64}$/)
  })

  it('counts voided ballots in the seal — they are still in the box', async () => {
    await voidOneBallot()
    await close()
    const row = await env.DB.prepare('SELECT ballot_count FROM election_seal').first<{ ballot_count: number }>()
    expect(row!.ballot_count).toBe(3)
  })

  it('REFUSES A SECOND CLOSE', async () => {
    await close()
    expect((await close()).status).toBe(409)
  })

  it('never overwrites an existing seal', async () => {
    await close()
    const before = await env.DB.prepare('SELECT ballots_sha256 FROM election_seal').first<{ ballots_sha256: string }>()
    await close()
    const after = await env.DB.prepare('SELECT ballots_sha256 FROM election_seal').first<{ ballots_sha256: string }>()
    expect(after!.ballots_sha256).toBe(before!.ballots_sha256)
  })

  it('seals a closed-but-unsealed election, so the operation is retryable', async () => {
    await env.DB.prepare(`UPDATE election SET status='closed', closed_at=? WHERE id=?`)
      .bind(Date.now(), f.electionId).run()
    const res = await close()
    expect(res.status).toBe(200)
    const row = await env.DB.prepare('SELECT count(*) c FROM election_seal').first<{ c: number }>()
    expect(row!.c).toBe(1)
  })

  it('REFUSES A BALLOT once closed', async () => {
    await close()
    const cookie = f.voterCookies['2400006'] ?? f.voterCookies['2400001']!
    expect((await submitBallot(f.batchId, f.electionId, cookie, [f.candidateIds.a])).status).toBe(409)
  })

  it('produces the digest spec §2 defines, sorted by id', async () => {
    await close()
    const sealed = await env.DB.prepare('SELECT ballots_sha256 FROM election_seal').first<{ ballots_sha256: string }>()
    const rows = await env.DB
      .prepare('SELECT id, preferences, voided FROM ballot WHERE election_id = ? ORDER BY id')
      .bind(f.electionId).all<{ id: string; preferences: string; voided: number }>()
    const canonical = rows.results.map((r) => `${r.id}|${r.preferences}|${r.voided}`).join('\n')
    expect(sealed!.ballots_sha256).toBe(await sha256Hex(canonical))
  })

  it('CLEARS the ballot-to-voter link on every receipt — HANDOFF §2', async () => {
    // While an election is open, live_receipt_hash joins a usu_id to that
    // ballot's preferences. Nothing can be voided after close, so the link has
    // no remaining purpose and must not outlive the count.
    const before = await env.DB
      .prepare('SELECT count(*) c FROM vote_receipt WHERE live_receipt_hash IS NOT NULL')
      .first<{ c: number }>()
    expect(before!.c).toBe(3)
    await close()
    const after = await env.DB
      .prepare('SELECT count(*) c FROM vote_receipt WHERE live_receipt_hash IS NOT NULL')
      .first<{ c: number }>()
    expect(after!.c).toBe(0)
  })

  it('leaves another election\'s links alone when one closes', async () => {
    const otherId = await createElection(f.batchId, f.officerCookie, 'Treasurer', 1)
    const x = await addCandidate(f.batchId, f.officerCookie, otherId, 'Eve')
    await addCandidate(f.batchId, f.officerCookie, otherId, 'Fred')
    await SELF.fetch(`https://example.com/api/batches/${f.batchId}/elections/${otherId}/open`, {
      method: 'POST', headers: { cookie: f.officerCookie },
    })
    await submitBallot(f.batchId, otherId, f.voterCookies['2400001']!, [x])
    await close()
    const row = await env.DB
      .prepare('SELECT count(*) c FROM vote_receipt WHERE election_id = ? AND live_receipt_hash IS NOT NULL')
      .bind(otherId).first<{ c: number }>()
    expect(row!.c).toBe(1)
  })

  it('keeps the mark-off and the ballots after close', async () => {
    await close()
    const receipts = await env.DB.prepare('SELECT count(*) c FROM vote_receipt').first<{ c: number }>()
    const ballots = await env.DB.prepare('SELECT count(*) c FROM ballot').first<{ c: number }>()
    expect(receipts!.c).toBe(3)
    expect(ballots!.c).toBe(3)
  })

  it('records an audit row with the ballot count and no identities', async () => {
    await close()
    const row = await env.DB.prepare(`SELECT detail FROM audit_log WHERE action = 'election.close'`)
      .first<{ detail: string }>()
    expect(JSON.parse(row!.detail)).toMatchObject({ kind: 'election_close', ballotCount: 3 })
    expect(row!.detail).not.toMatch(/\d{7}/)
  })
})
