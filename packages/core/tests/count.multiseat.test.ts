import { describe, it, expect } from 'vitest'
import { count } from '../src/count.js'
import type { CountInput, CountResult } from '../src/types.js'

const ballots = (spec: [string[], number][]) =>
  spec.flatMap(([prefs, n]) =>
    Array.from({ length: n }, (_, i) => ({ id: `${prefs.join('')}-${i}`, preferences: prefs })),
  )

const cands = (ids: string[]) => ids.map((id) => ({ id, name: id.toUpperCase() }))

const votesOf = (r: CountResult, round: number, id: string) =>
  r.rounds[round]!.counts.find((c) => c.candidateId === id)!.votes

describe('a surplus must skip a candidate an EARLIER surplus in the same round elected', () => {
  /*
   * The Open Critical from HANDOFF.md section 2, reproduced exactly.
   *
   * 6 candidates, 4 seats, 40 ballots:
   *   18 x [a,c,d]   12 x [b,c,e]   4 x [d]   3 x [e]   3 x [f]
   * quota = floor(40/5) + 1 = 9.
   *
   * Round 1 first preferences: a=18, b=12, c=0, d=4, e=3, f=3.
   * Both a and b are at or above quota, so both are elected before a paper
   * moves - a first, on 18.00000.
   *
   *   a's surplus = 18 - 9 = 9.00000 over 18 papers -> TV 0.50000 exactly.
   *   All 18 papers move to c (a is no longer continuing), so c goes from
   *   0.00000 to exactly 9.00000 - THE QUOTA.
   *
   * Commonwealth Electoral Act s273(8) elects c at that count; s273(1) then
   * stops c being a continuing candidate. b's surplus must therefore SKIP c.
   *
   *   b's surplus = 12 - 9 = 3.00000 over 12 papers -> TV 0.25000 exactly.
   *   The papers read [b,c,e]; b is elected and c is now elected, so all 12
   *   land on e: e = 3.00000 + 3.00000 = 6.00000.
   *
   * End of round 1: a=9, b=9, c=9, d=4, e=6, f=3 (= 40, nothing lost).
   * Round 2 excludes f (3.00000, safely below d's 4.00000); its papers
   * exhaust. Round 3 excludes d (4.00000 against e's 6.00000). Round 4 has
   * one continuing candidate for one seat, so e is elected by the fill rule.
   *
   *   WINNERS: a, b, c, e
   *
   * The defect: with statuses frozen for the whole round, b's 3.00000 was
   * poured onto c anyway, lifting c to 12.00000 and MANUFACTURING a 3.00000
   * surplus which round 2 then redistributed by C's preferences - 18 papers
   * to d and 12 to e at 0.10000 each, putting d on 5.80000 against e's
   * 4.20000. e was excluded and the last seat went to d instead.
   *
   *   WINNERS (defective): a, b, c, d
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
   * Before the sub-round fix the `election_order` tie-break was INERT.
   * Because no status changed inside the distribution loop, each elected
   * candidate's surplus, transfer value and destination set were independent
   * of the order they were distributed in, and non-transferable accumulated
   * commutatively - so two runs overriding the same tie in opposite
   * directions produced byte-identical round tables. Spec section 3 says
   * "election order determines transfer order"; here it determined nothing.
   *
   * This is the election that proves the machinery is alive again.
   *
   * 6 candidates, 4 seats, 25 ballots:
   *   10 x [a,c,d]   10 x [b,c,e]   2 x [c]   3 x [f]
   * quota = floor(25/5) + 1 = 6.
   *
   * a and b are tied at 10.00000 - a GENUINE election_order tie, and the
   * only tie-break in the count (tb-1). Each has a surplus of 4.00000 over
   * 10 papers: TV 0.40000 exactly, carrying exactly 4.00000.
   *
   * c starts on 2.00000, so WHICHEVER of a or b distributes first lifts c to
   * exactly 6.00000 = the quota. c is elected at that count, and the SECOND
   * surplus then skips c and runs on to that candidate's third preference.
   *
   *   tb-1 -> a : a's papers make c; b's 4.00000 runs past c to e.
   *   tb-1 -> b : b's papers make c; a's 4.00000 runs past c to d.
   *
   * Three seats are then filled (a, b, c) with one left and three continuing
   * candidates, of whom the one carrying the second surplus holds 4.00000
   * against f's 3.00000 and the other's 0.00000. d and f (or e and f) are
   * bulk-excluded together - 0.00000 + 3.00000 is safely below 4.00000 - and
   * the survivor takes the last seat under the fill rule.
   *
   * So one officer decision about who is elected FIRST decides whether the
   * fourth seat goes to d or to e.
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
