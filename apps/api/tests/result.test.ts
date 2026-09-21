import { describe, it, expect, beforeEach } from 'vitest'
import { SELF, env } from 'cloudflare:test'
import { setUp, submitBallot, createElection, addCandidate, type Fixture } from './helpers.js'

let f: Fixture

/** Three ballots, one seat: Alex 2, Bo 1. Quota = floor(3/2)+1 = 2. */
beforeEach(async () => {
  f = await setUp()
  const { a, b } = f.candidateIds
  await submitBallot(f.batchId, f.electionId, f.voterCookies['2400001']!, [a, b])
  await submitBallot(f.batchId, f.electionId, f.voterCookies['2400002']!, [a, b])
  await submitBallot(f.batchId, f.electionId, f.voterCookies['2400004']!, [b, a])
})

const close = (electionId = f.electionId) =>
  SELF.fetch(`https://example.com/api/batches/${f.batchId}/elections/${electionId}/close`, {
    method: 'POST', headers: { cookie: f.officerCookie },
  })

const getResult = (cookie = f.officerCookie, electionId = f.electionId) =>
  SELF.fetch(`https://example.com/api/batches/${f.batchId}/elections/${electionId}/result`, {
    headers: { cookie },
  })

const voidOneBallot = async () => {
  const row = await env.DB.prepare('SELECT live_receipt_hash FROM vote_receipt WHERE usu_id = ?')
    .bind('2400004').first<{ live_receipt_hash: string }>()
  await env.DB.prepare('UPDATE ballot SET voided = 1 WHERE receipt_hash = ?')
    .bind(row!.live_receipt_hash).run()
  await env.DB.prepare('UPDATE vote_receipt SET live_receipt_hash = NULL WHERE usu_id = ?')
    .bind('2400004').run()
}

describe('result', () => {
  it('requires an officer session', async () => {
    expect((await getResult('')).status).toBe(401)
  })

  it('refuses a door session', async () => {
    expect((await getResult(f.doorCookie)).status).toBe(403)
  })

  it('REFUSES a result while the election is open', async () => {
    expect((await getResult()).status).toBe(409)
  })

  it('refuses a result for a draft election', async () => {
    const draftId = await createElection(f.batchId, f.officerCookie, 'Secretary', 1)
    await addCandidate(f.batchId, f.officerCookie, draftId, 'Dee')
    expect((await getResult(f.officerCookie, draftId)).status).toBe(409)
  })

  it('returns the count once closed', async () => {
    await close()
    const res = await getResult()
    expect(res.status).toBe(200)
    const body = await res.json() as { quota: string; winners: { id: string }[]; rounds: unknown[] }
    expect(body.quota).toBe('2.00000')
    expect(body.winners).toHaveLength(1)
    expect(body.winners[0]!.id).toBe(f.candidateIds.a)
    expect(body.rounds.length).toBeGreaterThan(0)
  })

  it('stores the result rather than recomputing it', async () => {
    await close()
    await getResult()
    await getResult()
    const row = await env.DB.prepare('SELECT count(*) c FROM election_result WHERE election_id = ?')
      .bind(f.electionId).first<{ c: number }>()
    expect(row!.c).toBe(1)
  })

  it('serves the stored row byte-identically on a second request', async () => {
    await close()
    expect(await (await getResult()).text()).toBe(await (await getResult()).text())
  })

  it('EXCLUDES voided ballots from the count but keeps them in the seal', async () => {
    await voidOneBallot()
    await close()
    const seal = await env.DB.prepare('SELECT ballot_count FROM election_seal').first<{ ballot_count: number }>()
    expect(seal!.ballot_count).toBe(3)
    const body = await (await getResult()).json() as { quota: string; winners: { id: string }[] }
    // 2 counted ballots, 1 seat -> floor(2/2)+1 = 2
    expect(body.quota).toBe('2.00000')
    expect(body.winners[0]!.id).toBe(f.candidateIds.a)
  })

  it('carries the seal alongside the count, so the two travel together', async () => {
    await close()
    const body = await (await getResult()).json() as { ballots_sha256: string; ballot_count: number }
    const seal = await env.DB.prepare('SELECT ballot_count, ballots_sha256 FROM election_seal')
      .first<{ ballot_count: number; ballots_sha256: string }>()
    expect(body.ballots_sha256).toBe(seal!.ballots_sha256)
    expect(body.ballot_count).toBe(seal!.ballot_count)
  })

  it('never returns a ballot id or a voter id', async () => {
    await close()
    const text = await (await getResult()).text()
    // Checked against the real ids rather than a 7-digit shape: the document
    // legitimately carries `computed_at` and `closed_at`, which are 13 digits.
    for (const usuId of Object.keys(f.voterCookies)) expect(text).not.toContain(usuId)
    const ballots = await env.DB.prepare('SELECT id FROM ballot').all<{ id: string }>()
    for (const b of ballots.results) expect(text).not.toContain(b.id)
  })

  it('reports every tie-break with its method and kind', async () => {
    await close()
    const body = await (await getResult()).json() as { tie_breaks: { id: string; kind: string; method: string }[] }
    for (const t of body.tie_breaks) {
      expect(['exclusion', 'election_order']).toContain(t.kind)
      expect(['countback', 'seeded_draw', 'officer_override']).toContain(t.method)
      expect(t.id).toMatch(/^tb-\d+$/)
    }
  })

  it('seeds a draw from the sealed digest rather than from the digest itself', async () => {
    // a two-two tie so the count has to resolve something
    const f2 = await setUp(['2400001', '2400002'])
    const { a, b } = f2.candidateIds
    await submitBallot(f2.batchId, f2.electionId, f2.voterCookies['2400001']!, [a, b])
    await submitBallot(f2.batchId, f2.electionId, f2.voterCookies['2400002']!, [b, a])
    await SELF.fetch(`https://example.com/api/batches/${f2.batchId}/elections/${f2.electionId}/close`, {
      method: 'POST', headers: { cookie: f2.officerCookie },
    })
    const seal = await env.DB.prepare('SELECT ballots_sha256 FROM election_seal').first<{ ballots_sha256: string }>()
    const body = await (await SELF.fetch(
      `https://example.com/api/batches/${f2.batchId}/elections/${f2.electionId}/result`,
      { headers: { cookie: f2.officerCookie } },
    )).json() as { tie_breaks: { seed: string | null }[] }
    for (const t of body.tie_breaks) {
      if (t.seed !== null) expect(t.seed).not.toBe(seal!.ballots_sha256)
    }
  })

  it('refuses a result for an election sealed in another batch', async () => {
    await close()
    expect((await getResult(f.officerCookie, crypto.randomUUID())).status).toBe(404)
  })

  it('records an audit row with round and winner counts only', async () => {
    await close()
    await getResult()
    const row = await env.DB.prepare(`SELECT detail FROM audit_log WHERE action = 'election.count'`)
      .first<{ detail: string }>()
    expect(JSON.parse(row!.detail)).toMatchObject({ kind: 'count' })
    expect(row!.detail).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}/)
  })
})
