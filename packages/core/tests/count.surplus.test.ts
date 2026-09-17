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

  // NOTE: no "conserves votes through a surplus transfer" test. recordRound()
  // already refuses to record a round whose votes do not sum exactly, in
  // bigint; the float restatement of it (toBeCloseTo(12, 3)) tolerated leakage
  // of up to 5e-4 that the exact check catches, and could only run at all in
  // the case where the exact check had already passed.
})

describe('a second surplus, over papers of mixed weight', () => {
  /*
   * The case IGM's documented defect actually shows up in: a candidate elected
   * AFTER receiving transfers, distributing a surplus over papers that arrived
   * at three different values. Hand-computed in full below, because this is
   * precisely the arithmetic a scrutineer would be checking on paper.
   *
   * 21 ballots, 2 seats -> quota = floor(21/3) + 1 = 8.
   *   a: 9 x ['a','b']      b: 6 x ['b','c']      c: 6 x ['c','b']
   *
   * Round 1 - a holds 9.00000, surplus 1.00000 over 9 papers.
   *   TV1 = 1/9 = 0.111111... -> 0.11111 truncated.
   *   a retains 8.00000; b receives 9 papers worth 9 x 0.11111 = 0.99999,
   *   reaching 6.99999. Loss by fraction 0.00001 books to non-transferable.
   *
   * Round 2 - nobody is at quota. c is lowest on 6.00000 (b is on 6.99999),
   *   so c is excluded and its 6 papers move at their CURRENT value, 1.00000
   *   each. b reaches 12.99999.
   *
   * Round 3 - b is elected. Surplus = 12.99999 - 8.00000 = 4.99999, held on
   *   21 papers of three different weights: 6 of its own at 1.00000, 9 from
   *   a's surplus at 0.11111, and 6 from c's exclusion at 1.00000.
   *   TV2 = 4.99999 / 21 = 0.2380947... -> 0.23809 truncated.
   *
   *   THIS is the defect, made concrete: the 9 papers that arrived at 0.11111
   *   each move onward at 0.23809 - more than double the value they came in
   *   with. IGM divides the surplus by the NUMBER of papers, never by their
   *   value, so a paper's weight is rewritten at every distribution. Accepted
   *   deliberately (spec section 3) in exchange for one checkable number per
   *   distribution.
   *
   *   Every paper exhausts (c is gone), so 21 x 0.23809 = 4.99989 goes to
   *   non-transferable, plus 4.99999 - 4.99989 = 0.00010 loss by fraction and
   *   round 1's 0.00001: 5.00000 exactly. 8 + 8 + 5 = 21.
   */
  const secondSurplus = () =>
    count(
      input({
        ballots: ballots([
          [['a', 'b'], 9],
          [['b', 'c'], 6],
          [['c', 'b'], 6],
        ]),
      }),
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
