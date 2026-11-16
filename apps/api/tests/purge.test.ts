import { describe, it, expect, beforeEach } from 'vitest'
import { env } from 'cloudflare:test'
import {
  addCandidate, addDoorVoter, addGuest, api, cast, closeElection, countOf, createBatch,
  createElection, getResult, setUp, type Fixture,
} from './helpers.js'

let f: Fixture

beforeEach(async () => {
  f = await setUp(['2400001'])
  await cast(f, '2400001', 'a')
})

const purge = () => api('DELETE', `/batches/${f.batchId}/roll`, f.officerCookie)

describe('roll purge', () => {
  it('REFUSES while an election is still open, saying how many', async () => {
    const res = await purge()
    expect(res.status).toBe(409)
    const body = await res.json() as { error: string; remaining: number }
    expect(body.remaining).toBe(1)
    expect(body.error).toMatch(/1/)
    expect(await countOf('voter_roll')).toBe(6)
  })

  it('refuses while an election is still in draft', async () => {
    await closeElection(f)
    const laterId = await createElection(f.batchId, f.officerCookie, 'Later', 1)
    await addCandidate(f.batchId, f.officerCookie, laterId, 'Dee')
    expect((await purge()).status).toBe(409)
    expect(await countOf('voter_roll')).toBe(6)
  })

  it('purges the roll, check-ins and guests once every election is closed, idempotently', async () => {
    // a guest's name is personal data; a door-added member is a roll row like any other
    await addGuest(f)
    await addDoorVoter(f)
    await closeElection(f)
    const res = await purge()
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ voter_roll: 7, check_in: 2, guest: 1 })
    for (const table of ['voter_roll', 'check_in', 'guest']) expect(await countOf(table), table).toBe(0)
    expect(await (await purge()).json()).toEqual({ voter_roll: 0, check_in: 0, guest: 0 })
  })

  it('KEEPS the ballots, the seal, the result and the mark-off, unchanged and unlinked', async () => {
    await closeElection(f)
    const ballots = () => api('GET', `/batches/${f.batchId}/elections/${f.electionId}/ballots.csv`, f.officerCookie)
    const before = { result: await (await getResult(f)).text(), ballots: await (await ballots()).text() }
    await purge()
    // the count was sealed against the ballots, not the roll
    expect({ result: await (await getResult(f)).text(), ballots: await (await ballots()).text() }).toEqual(before)
    for (const table of ['ballot', 'election_seal', 'election_result', 'vote_receipt']) {
      expect(await countOf(table), table).toBe(1)
    }
    expect(await countOf('vote_receipt', 'live_receipt_hash IS NOT NULL')).toBe(0)
  })

  it('does not touch another batch\'s roll', async () => {
    await closeElection(f)
    const otherId = await createBatch('other', 2)
    await env.DB.prepare('INSERT INTO voter_roll (batch_id, usu_id, first_name, last_name, eligible) VALUES (?,?,?,?,1)')
      .bind(otherId, '2400009', 'Someone', 'Else').run()
    await purge()
    expect(await countOf('voter_roll', 'batch_id = ?', otherId)).toBe(1)
  })
})
