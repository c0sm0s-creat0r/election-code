import { describe, it, expect } from 'vitest'
import { recount } from '../src/recount.js'
import * as core from '../src/index.js'

describe('public surface', () => {
  it('exports what apps/api and the frontends need', () => {
    for (const name of [
      'count', 'validateBallot', 'minimumPreferences', 'droopQuota',
      'parseUsuExport', 'recount', 'format', 'VERSION',
    ]) {
      expect(core).toHaveProperty(name)
    }
  })
})

describe('recount', () => {
  const candidatesCsv = 'candidate_id,name\na,Alex\nb,Bo\nc,Cass\n'
  const ballotsCsv = [
    'ballot_id,preferences',
    'b1,"a|b"', 'b2,"a|b"', 'b3,"a|b"', 'b4,"a|b"',
    'b5,"b|a"', 'b6,"b|a"', 'b7,"b|a"', 'b8,"b|a"',
    'b9,"c|a"', 'b10,"c|a"',
  ].join('\n')

  it('reproduces a count from exported CSVs alone', async () => {
    const r = await recount(ballotsCsv, candidatesCsv, 1, 'e1', 'ee'.repeat(8))
    expect(r.winners.map((w) => w.id)).toEqual(['a'])
  })

  it('gives the same result as counting the same data directly', async () => {
    const viaCsv = await recount(ballotsCsv, candidatesCsv, 1, 'e1', 'ee'.repeat(8))
    const direct = await core.count({
      candidates: [
        { id: 'a', name: 'Alex' }, { id: 'b', name: 'Bo' }, { id: 'c', name: 'Cass' },
      ],
      ballots: [
        ...Array.from({ length: 4 }, (_, i) => ({ id: `b${i + 1}`, preferences: ['a', 'b'] })),
        ...Array.from({ length: 4 }, (_, i) => ({ id: `b${i + 5}`, preferences: ['b', 'a'] })),
        ...Array.from({ length: 2 }, (_, i) => ({ id: `b${i + 9}`, preferences: ['c', 'a'] })),
      ],
      seats: 1,
      electionId: 'e1',
      ballotsSha256: 'ee'.repeat(8),
    })
    expect(viaCsv.winners).toEqual(direct.winners)
    expect(viaCsv.quota).toBe(direct.quota)
  })
})
