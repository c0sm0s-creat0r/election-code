import { describe, it, expect } from 'vitest'
import { count } from '../src/count.js'
import type { CountInput } from '../src/types.js'

const input = (over: Partial<CountInput>): CountInput => ({
  candidates: [
    { id: 'a', name: 'Alex' },
    { id: 'b', name: 'Bo' },
    { id: 'c', name: 'Cass' },
  ],
  ballots: [],
  seats: 2,
  electionId: 'e1',
  ballotsSha256: 'deadbeef00000000',
  ...over,
})

const ballots = (spec: [string[], number][]) =>
  spec.flatMap(([prefs, n]) =>
    Array.from({ length: n }, (_, i) => ({ id: `${prefs.join('')}-${i}`, preferences: prefs })),
  )

describe('surplus transfers (IGM)', () => {
  it('transfer value is surplus divided by the NUMBER of papers', async () => {
    // 12 ballots, 2 seats -> quota = floor(12/3)+1 = 5
    // a gets 9 first preferences: surplus 4, over 9 papers -> TV = 0.44444
    const r = await count(
      input({ ballots: ballots([[['a', 'b'], 9], [['c', 'b'], 3]]) }),
    )
    const elected = r.rounds.flatMap((x) => x.elected).find((e) => e.candidateId === 'a')!
    expect(elected.surplus).toBe('4.00000')
    expect(elected.transferValue).toBe('0.44444') // 4/9 truncated, NOT 0.44445
  })

  it('moves every paper at the same value, replacing its old weight', async () => {
    // this is what makes IGM hand-checkable: ONE number per distribution
    const r = await count(
      input({ ballots: ballots([[['a', 'b'], 9], [['c', 'b'], 3]]) }),
    )
    // b receives 9 papers at 0.44444 in the round a's surplus is
    // distributed = 3.99996
    const round1 = r.rounds[0]!
    expect(round1.counts.find((c) => c.candidateId === 'b')!.votes).toBe('3.99996')
  })

  it('sends exhausted papers to non-transferable', async () => {
    // a's surplus papers have no further preference
    const r = await count(
      input({ ballots: ballots([[['a'], 9], [['b'], 2], [['c'], 1]]) }),
    )
    const last = r.rounds[r.rounds.length - 1]!
    expect(Number(last.nonTransferable)).toBeGreaterThan(0)
  })

  it('conserves votes through a surplus transfer', async () => {
    const r = await count(
      input({ ballots: ballots([[['a', 'b'], 9], [['c', 'b'], 3]]) }),
    )
    for (const round of r.rounds) {
      const total =
        round.counts.reduce((s, c) => s + Number(c.votes), 0) + Number(round.nonTransferable)
      expect(total).toBeCloseTo(12, 3) // truncation loses <1e-4 per paper
    }
  })
})
