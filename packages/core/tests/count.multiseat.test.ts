import { describe, it, expect } from 'vitest'
import { count } from '../src/count.js'
import type { CountInput, CountResult } from '../src/types.js'
import { ballots } from './helpers.js'


const cands = (ids: string[]) => ids.map((id) => ({ id, name: id.toUpperCase() }))

const votesOf = (r: CountResult, round: number, id: string) =>
  r.rounds[round]!.counts.find((c) => c.candidateId === id)!.votes

describe('a surplus must skip a candidate an EARLIER surplus in the same round elected', () => {
  /*
   * 6 candidates, 4 seats, 40 ballots, quota = floor(40/5) + 1 = 9:
   *   18 x [a,c,d]   12 x [b,c,e]   4 x [d]   3 x [e]   3 x [f]
   *
   * Round 1: a=18 and b=12 are both elected before a paper moves.
   *   a's surplus 9.00000 over 18 papers, TV 0.50000, all to c: c = 9.00000,
   *   exactly the quota, so c is elected at that count (CEA s273(8)).
   *   b's surplus 3.00000 over 12 papers, TV 0.25000, skips c and lands on e:
   *   e = 6.00000.
   * End of round 1: a=9 b=9 c=9 d=4 e=6 f=3.
   * Round 2 excludes f, round 3 excludes d, round 4 elects e by the fill rule.
   *
   *   WINNERS: a, b, c, e
   *
   * If b's surplus is poured onto c instead, c's manufactured 3.00000 surplus
   * is redistributed by c's preferences and the last seat goes to d.
   */
  const run = () =>
    count({
      candidates: cands(['a', 'b', 'c', 'd', 'e', 'f']),
      ballots: ballots([
        [['a', 'c', 'd'], 18],
        [['b', 'c', 'e'], 12],
        [['d'], 4],
        [['e'], 3],
        [['f'], 3],
      ]),
      seats: 4,
      electionId: 'handoff-critical',
      ballotsSha256: 'ab'.repeat(8),
    })

  it('elects c in the SAME round as a and b, not a later one', async () => {
    const r = await run()
    expect(r.quota).toBe('9.00000')
    expect(r.rounds[0]!.elected.map((e) => e.candidateId)).toEqual(['a', 'b', 'c'])
  })

  it('never lets c exceed the quota, so there is no manufactured surplus', async () => {
    const r = await run()
    const c = r.rounds[0]!.elected.find((e) => e.candidateId === 'c')!
    expect(c.surplus).toBe('0.00000')
    expect(c.transferValue).toBe('0.00000')
    expect(votesOf(r, 0, 'c')).toBe('9.00000')
  })

  it("pours b's surplus onto e, the next continuing preference after c", async () => {
    const r = await run()
    expect(r.rounds[0]!.elected.find((e) => e.candidateId === 'a')).toMatchObject({
      surplus: '9.00000',
      transferValue: '0.50000',
    })
    expect(r.rounds[0]!.elected.find((e) => e.candidateId === 'b')).toMatchObject({
      surplus: '3.00000',
      transferValue: '0.25000',
    })
    expect(votesOf(r, 0, 'e')).toBe('6.00000')
    expect(votesOf(r, 0, 'd')).toBe('4.00000')
    expect(r.rounds[0]!.nonTransferable).toBe('0.00000')
  })

  it('gives the fourth seat to e, as the Senate rule requires - not to d', async () => {
    const r = await run()
    expect(r.winners.map((w) => w.id)).toEqual(['a', 'b', 'c', 'e'])
  })
})

describe('election_order is load-bearing: the same tie, resolved both ways, moves a seat', () => {
  /*
   * The `election_order` tie-break decides a seat here.
   *
   * 6 candidates, 4 seats, 25 ballots, quota = floor(25/5) + 1 = 6:
   *   10 x [a,c,d]   10 x [b,c,e]   2 x [c]   3 x [f]
   *
   * a and b tie on 10.00000 (tb-1), each with a surplus of 4.00000 at TV
   * 0.40000. c starts on 2.00000, so whichever distributes first lifts c to
   * exactly the quota, and the second surplus skips c:
   *
   *   tb-1 -> a : b's 4.00000 runs past c to e, and e takes the last seat.
   *   tb-1 -> b : a's 4.00000 runs past c to d, and d takes the last seat.
   */
  const args: CountInput = {
    candidates: cands(['a', 'b', 'c', 'd', 'e', 'f']),
    ballots: ballots([
      [['a', 'c', 'd'], 10],
      [['b', 'c', 'e'], 10],
      [['c'], 2],
      [['f'], 3],
    ]),
    seats: 4,
    electionId: 'election-order',
    ballotsSha256: 'cd'.repeat(8),
  }

  const withOverride = (candidateId: string) =>
    count({
      ...args,
      overrides: {
        'tb-1': { candidateId, reason: 'Lots drawn in the room, as the constitution requires' },
      },
    })

  it('offers a genuine two-way election_order tie and nothing else', async () => {
    const r = await count(args)
    expect(r.quota).toBe('6.00000')
    expect(r.tieBreaks).toHaveLength(1)
    expect(r.tieBreaks[0]).toMatchObject({
      id: 'tb-1',
      kind: 'election_order',
      round: 1,
      candidates: ['a', 'b'],
    })
  })

  it('sends the last seat to e when a is elected first', async () => {
    const r = await withOverride('a')
    expect(r.tieBreaks[0]!.method).toBe('officer_override')
    expect(r.rounds[0]!.elected.map((e) => e.candidateId)).toEqual(['a', 'b', 'c'])
    expect(votesOf(r, 0, 'e')).toBe('4.00000')
    expect(votesOf(r, 0, 'd')).toBe('0.00000')
    expect(r.winners.map((w) => w.id)).toEqual(['a', 'b', 'c', 'e'])
  })

  it('sends the last seat to d when b is elected first', async () => {
    const r = await withOverride('b')
    expect(r.rounds[0]!.elected.map((e) => e.candidateId)).toEqual(['b', 'a', 'c'])
    expect(votesOf(r, 0, 'd')).toBe('4.00000')
    expect(votesOf(r, 0, 'e')).toBe('0.00000')
    expect(r.winners.map((w) => w.id)).toEqual(['b', 'a', 'c', 'd'])
  })

  it('produces different round tables and a different winner either way', async () => {
    const first = await withOverride('a')
    const second = await withOverride('b')
    expect(JSON.stringify(first.rounds)).not.toBe(JSON.stringify(second.rounds))
    expect(new Set(first.winners.map((w) => w.id))).not.toEqual(
      new Set(second.winners.map((w) => w.id)),
    )
  })
})
