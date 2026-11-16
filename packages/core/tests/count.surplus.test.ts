import { describe, it, expect } from 'vitest'
import { count } from '../src/count.js'
import type { CountBallot } from '../src/types.js'
import { ballots, input as base } from './helpers.js'

// two seats throughout
const input = (b: CountBallot[]) => base({ seats: 2, ballots: b })

describe('surplus transfers (IGM)', () => {
  it('transfer value is surplus divided by the NUMBER of papers', async () => {
    // 12 ballots, 2 seats -> quota = floor(12/3)+1 = 5
    // a gets 9 first preferences: surplus 4, over 9 papers -> TV = 0.44444
    const r = await count(
      input(ballots([[['a', 'b'], 9], [['c', 'b'], 3]])),
    )
    const elected = r.rounds.flatMap((x) => x.elected).find((e) => e.candidateId === 'a')!
    expect(elected.surplus).toBe('4.00000')
    expect(elected.transferValue).toBe('0.44444') // 4/9 truncated, NOT 0.44445
  })

  it('moves every paper at the same value, replacing its old weight', async () => {
    // IGM: one transfer value per distribution
    const r = await count(
      input(ballots([[['a', 'b'], 9], [['c', 'b'], 3]])),
    )
    // b receives 9 papers at 0.44444 in the round a's surplus is
    // distributed = 3.99996
    const round1 = r.rounds[0]!
    expect(round1.counts.find((c) => c.candidateId === 'b')!.votes).toBe('3.99996')
  })

  it('sends exhausted papers to non-transferable', async () => {
    // a's surplus papers have no further preference
    const r = await count(
      input(ballots([[['a'], 9], [['b'], 2], [['c'], 1]])),
    )
    const last = r.rounds[r.rounds.length - 1]!
    expect(Number(last.nonTransferable)).toBeGreaterThan(0)
  })

  // No float conservation test: recordRound() checks it exactly, in bigint.
})

describe('a second surplus, over papers of mixed weight', () => {
  /*
   * A candidate elected after receiving transfers, distributing a surplus over
   * papers that arrived at different values.
   *
   * 21 ballots, 2 seats, quota = floor(21/3) + 1 = 8:
   *   9 x [a,b]   6 x [b,c]   6 x [c,b]
   *
   * Round 1: a on 9.00000, surplus 1.00000 over 9 papers, TV 0.11111.
   *   b receives 0.99999 and reaches 6.99999; 0.00001 is lost by fraction.
   * Round 2: c (6.00000) is excluded and its 6 papers move at 1.00000.
   *   b = 12.99999.
   * Round 3: b is elected. Surplus 4.99999 over 21 papers, TV 0.23809.
   *   The 9 papers that arrived at 0.11111 now move at 0.23809: this is the
   *   known IGM cost (LIMITATIONS.md §5).
   *   Every paper exhausts: 21 x 0.23809 = 4.99989, plus 0.00010 and round 1's
   *   0.00001 lost by fraction, is 5.00000 non-transferable. 8 + 8 + 5 = 21.
   */
  const secondSurplus = () =>
    count(
      input(ballots([
        [['a', 'b'], 9],
        [['b', 'c'], 6],
        [['c', 'b'], 6],
      ])),
    )

  it('sets the first transfer value at 0.11111 and books the fraction lost', async () => {
    const r = await secondSurplus()
    expect(r.quota).toBe('8.00000')
    expect(r.rounds[0]!.elected).toEqual([
      { candidateId: 'a', name: 'Alex', surplus: '1.00000', transferValue: '0.11111' },
    ])
    expect(r.rounds[0]!.counts.find((c) => c.candidateId === 'b')!.votes).toBe('6.99999')
    expect(r.rounds[0]!.nonTransferable).toBe('0.00001')
  })

  it('carries an exclusion onward at full value, not at the surplus value', async () => {
    const r = await secondSurplus()
    expect(r.rounds[1]!.excluded.map((e) => e.candidateId)).toEqual(['c'])
    expect(r.rounds[1]!.counts.find((c) => c.candidateId === 'b')!.votes).toBe('12.99999')
  })

  it('moves a 0.11111 paper onward at 0.23809 - the IGM defect, exactly', async () => {
    const r = await secondSurplus()
    expect(r.rounds[2]!.elected).toEqual([
      { candidateId: 'b', name: 'Bo', surplus: '4.99999', transferValue: '0.23809' },
    ])
    // 21 papers of three different incoming weights, all rewritten to 0.23809
    expect(r.rounds[2]!.nonTransferable).toBe('5.00000')
    expect(r.rounds[2]!.counts.find((c) => c.candidateId === 'b')!.votes).toBe('8.00000')
    expect(r.winners.map((w) => w.id)).toEqual(['a', 'b'])
  })
})
