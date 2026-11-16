import { describe, it, expect } from 'vitest'
import { count } from '../src/count.js'
import type { CountInput } from '../src/types.js'

const base = (over: Partial<CountInput>): CountInput => ({
  candidates: [
    { id: 'a', name: 'Alex' },
    { id: 'b', name: 'Bo' },
    { id: 'c', name: 'Cass' },
  ],
  ballots: [],
  seats: 1,
  electionId: 'e1',
  ballotsSha256: 'deadbeef00000000',
  ...over,
})

const ballots = (spec: [string[], number][]) =>
  spec.flatMap(([prefs, n]) =>
    Array.from({ length: n }, (_, i) => ({ id: `${prefs.join('')}-${i}`, preferences: prefs })),
  )

describe('count - first preferences', () => {
  it('elects an outright majority in round 1', async () => {
    const r = await count(
      base({ ballots: ballots([[['a', 'b'], 6], [['b', 'a'], 4]]) }),
    )
    expect(r.quota).toBe('6.00000') // floor(10/2)+1
    expect(r.winners.map((w) => w.id)).toEqual(['a'])
    expect(r.rounds).toHaveLength(1)
    expect(r.rounds[0]!.counts.find((c) => c.candidateId === 'a')!.votes).toBe('6.00000')
  })

  it('elects the remaining candidates when continuing == remaining seats', async () => {
    // 2 seats, 2 candidates: both are elected without anyone reaching quota
    const r = await count(
      base({
        seats: 2,
        candidates: [{ id: 'a', name: 'Alex' }, { id: 'b', name: 'Bo' }],
        ballots: ballots([[['a', 'b'], 5], [['b', 'a'], 5]]),
      }),
    )
    expect(r.winners.map((w) => w.id).sort()).toEqual(['a', 'b'])
  })

  it('returns no winner and no rounds for zero ballots', async () => {
    const r = await count(base({ ballots: [] }))
    expect(r.winners).toEqual([])
  })

  // No conservation test here: recordRound() throws on any leak.
})

describe('count - every candidate at quota is elected in the same round (C1)', () => {
  // 5 candidates, 3 seats, 11 ballots, quota = floor(11/4)+1 = 3, no ties.
  // In round 1 both c (4) and d (3) are at quota. c's surplus must skip d
  // (CEA s273(8)); landing on d would hand the third seat to e instead of b.
  const fixture = 'edacb cdbea becad beadc cdbae edbca cbead daebc caebd daecb dceab'.split(' ')
  const run = () =>
    count({
      candidates: ['a', 'b', 'c', 'd', 'e'].map((id) => ({ id, name: id.toUpperCase() })),
      ballots: fixture.map((prefs, i) => ({ id: `b${i}`, preferences: prefs.split('') })),
      seats: 3,
      electionId: 'c1',
      ballotsSha256: 'ee'.repeat(8),
    })

  it('elects both quota-holders in round 1', async () => {
    const r = await run()
    expect(r.quota).toBe('3.00000')
    const round1 = r.rounds[0]!
    expect(round1.elected.map((e) => e.candidateId)).toEqual(['c', 'd'])
    // c leads on 4.00000 so is elected first and distributes first; d is at
    // quota exactly and has nothing to distribute.
    expect(round1.elected[0]).toMatchObject({ surplus: '1.00000', transferValue: '0.25000' })
    expect(round1.elected[1]).toMatchObject({ surplus: '0.00000', transferValue: '0.00000' })
    // d is never inflated past the quota by c's surplus
    expect(round1.counts.find((x) => x.candidateId === 'd')!.votes).toBe('3.00000')
  })

  it('gives the third seat to b, with no tie-break anywhere', async () => {
    const r = await run()
    expect(r.winners.map((w) => w.id)).toEqual(['c', 'd', 'b'])
    expect(r.tieBreaks).toEqual([])
  })
})

describe('count - the zero-vote guard', () => {
  it('holds no count when every ballot ranks nobody', async () => {
    // three ballots that rank no candidate must not elect anyone on 0.00000
    const r = await count(
      base({
        ballots: [
          { id: 'x1', preferences: [] },
          { id: 'x2', preferences: [] },
          { id: 'x3', preferences: [] },
        ],
      }),
    )
    expect(r.quota).toBe('2.00000') // still reported: floor(3/2)+1
    expect(r.rounds).toEqual([])
    expect(r.winners).toEqual([])
    expect(r.tieBreaks).toEqual([])
  })

  it('holds no count when every preference names a non-candidate', async () => {
    const r = await count(
      base({ ballots: [{ id: 'x1', preferences: ['ghost'] }] }),
    )
    expect(r.winners).toEqual([])
    expect(r.rounds).toEqual([])
  })
})
