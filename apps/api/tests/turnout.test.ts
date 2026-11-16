import { describe, it, expect, beforeEach } from 'vitest'
import {
  addCandidate, api, cast, closeElection, createElection, openElection, setUp, voidLiveBallot, type Fixture,
} from './helpers.js'

let f: Fixture

beforeEach(async () => {
  f = await setUp(['2400001', '2400002'])
  await cast(f, '2400001', 'a')
})

const turnout = (electionId = f.electionId) =>
  api('GET', `/batches/${f.batchId}/elections/${electionId}/turnout`, f.officerCookie)

describe('turnout', () => {
  it('is available WHILE the election is open, and NEVER leaks a tally at any status', async () => {
    // spec §4: turnout is visible while open, the count is not
    for (const stage of ['open', 'closed']) {
      if (stage === 'closed') await closeElection(f)
      const res = await turnout()
      expect(res.status).toBe(200)
      const text = await res.text()
      // exact equality: no candidate id, no name, no quota, no winner
      expect(JSON.parse(text), stage).toEqual({ ballots_cast: 1, voters_checked_in: 2, eligible: 4, added_at_door: 0 })
      for (const id of Object.values(f.candidateIds)) expect(text).not.toContain(id)
    }
  })

  it('counts only non-voided ballots', async () => {
    await voidLiveBallot('2400001')
    expect(await (await turnout()).json()).toMatchObject({ ballots_cast: 0 })
  })

  it('counts each election separately, a draft included', async () => {
    const otherId = await createElection(f.batchId, f.officerCookie, 'Treasurer', 1)
    for (const stage of ['draft', 'open']) {
      const res = await turnout(otherId)
      expect(res.status, stage).toBe(200)
      expect(await res.json()).toMatchObject({ ballots_cast: 0 })
      await addCandidate(f.batchId, f.officerCookie, otherId, 'Eve')
      await openElection(f.batchId, f.officerCookie, otherId)
    }
  })

  it('404s an election that is not this batch\'s', async () => {
    expect((await turnout(crypto.randomUUID())).status).toBe(404)
  })
})
