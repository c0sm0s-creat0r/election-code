import { describe, it, expect, beforeEach } from 'vitest'
import { SELF, env } from 'cloudflare:test'
import { setUp, submitBallot, createElection, addCandidate, type Fixture } from './helpers.js'

let f: Fixture

beforeEach(async () => {
  f = await setUp(['2400001', '2400002'])
  await submitBallot(f.batchId, f.electionId, f.voterCookies['2400001']!, [f.candidateIds.a])
})

const turnout = (cookie = f.officerCookie, electionId = f.electionId) =>
  SELF.fetch(`https://example.com/api/batches/${f.batchId}/elections/${electionId}/turnout`, {
    headers: { cookie },
  })

describe('turnout', () => {
  it('requires an officer session', async () => {
    expect((await turnout('')).status).toBe(401)
  })

  it('refuses a door session', async () => {
    expect((await turnout(f.doorCookie)).status).toBe(403)
  })

  it('is available WHILE the election is open — that is the point', async () => {
    const res = await turnout()
    expect(res.status).toBe(200)
    expect(await res.json())
      .toEqual({ ballots_cast: 1, voters_checked_in: 2, eligible: 4, added_at_door: 0 })
  })

  it('NEVER leaks a tally, at any status', async () => {
    // spec §4: turnout is visible while open, the count is not. A per-candidate
    // figure here would reopen exactly what closing exists to control.
    for (const stage of ['open', 'closed'] as const) {
      if (stage === 'closed') {
        await SELF.fetch(`https://example.com/api/batches/${f.batchId}/elections/${f.electionId}/close`, {
          method: 'POST', headers: { cookie: f.officerCookie },
        })
      }
      const res = await turnout()
      const text = await res.text()
      for (const id of Object.values(f.candidateIds)) {
        expect(text, `candidate id leaked while ${stage}`).not.toContain(id)
      }
      expect(text).not.toMatch(/Alex|Bo|quota|winner|round/i)
      expect(Object.keys(JSON.parse(text) as object).sort())
        .toEqual(['added_at_door', 'ballots_cast', 'eligible', 'voters_checked_in'])
    }
  })

  it('counts only non-voided ballots', async () => {
    const row = await env.DB.prepare('SELECT live_receipt_hash FROM vote_receipt WHERE usu_id = ?')
      .bind('2400001').first<{ live_receipt_hash: string }>()
    await env.DB.prepare('UPDATE ballot SET voided = 1 WHERE receipt_hash = ?')
      .bind(row!.live_receipt_hash).run()
    expect(await (await turnout()).json()).toMatchObject({ ballots_cast: 0 })
  })

  it('counts each election separately', async () => {
    const otherId = await createElection(f.batchId, f.officerCookie, 'Treasurer', 1)
    await addCandidate(f.batchId, f.officerCookie, otherId, 'Eve')
    await addCandidate(f.batchId, f.officerCookie, otherId, 'Fred')
    await SELF.fetch(`https://example.com/api/batches/${f.batchId}/elections/${otherId}/open`, {
      method: 'POST', headers: { cookie: f.officerCookie },
    })
    expect(await (await turnout(f.officerCookie, otherId)).json()).toMatchObject({ ballots_cast: 0 })
  })

  it('is available for a draft election, reporting nothing cast', async () => {
    const draftId = await createElection(f.batchId, f.officerCookie, 'Secretary', 1)
    const res = await turnout(f.officerCookie, draftId)
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ballots_cast: 0 })
  })

  it('404s an election in another batch', async () => {
    expect((await turnout(f.officerCookie, crypto.randomUUID())).status).toBe(404)
  })
})
