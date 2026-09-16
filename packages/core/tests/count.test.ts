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

  it('conserves votes in every round', async () => {
    const r = await count(
      base({ ballots: ballots([[['a', 'b'], 6], [['b', 'a'], 4]]) }),
    )
    for (const round of r.rounds) {
      const total =
        round.counts.reduce((s, c) => s + Number(c.votes), 0) + Number(round.nonTransferable)
      expect(total).toBeCloseTo(10, 4)
    }
  })
})
