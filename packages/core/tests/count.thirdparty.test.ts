import { describe, it, expect } from 'vitest'
import { count } from '../src/count.js'
import fx from './fixtures/third-party/concretestv-simple-example.json' with { type: 'json' }

/**
 * Differential against ConcreteSTV (github.com/AndrewConway/ConcreteSTV), an
 * independent implementation of the federal rules. No small official IGM
 * count is published (LIMITATIONS.md §3).
 *
 * The fixture does not separate IGM from WIGM: every round-1 surplus paper is
 * at full value, and the one mixed-weight transfer (A2's) is for the final
 * seat. It pins the quota, election at quota, exclusion order, exhaustion
 * and the winner set.
 *
 * ConcreteSTV stores above-the-line tickets. Each is expanded to its
 * preference list, recorded in the fixture's `_from` fields.
 */
const ballots = () =>
  (fx.ballotGroups as { preferences: string[]; n: number }[]).flatMap((g, gi) =>
    Array.from({ length: g.n }, (_, i) => ({ id: `g${gi}-${i}`, preferences: g.preferences })),
  )

const run = () =>
  count({
    candidates: fx.candidates,
    ballots: ballots(),
    seats: fx.seats,
    electionId: 'concretestv-simple',
    ballotsSha256: 'ab'.repeat(8),
  })

describe('ConcreteSTV SimpleExample (AEC2013 rules)', () => {
  it('expands the party tickets to 240 ballots', () => {
    expect(ballots()).toHaveLength(240)
  })

  it('computes the same quota', async () => {
    expect((await run()).quota).toBe(fx.quota)
  })

  it('elects the same three candidates', async () => {
    // Compared as a set: C1 and A1 tie on 110, so which is elected first is a
    // seeded draw that varies with the election id.
    const winners = (await run()).winners.map((w) => w.id).sort()
    expect(winners).toEqual([...(fx.expectedWinners as string[])].sort())
  })

  it('resolves the equal-surplus tie between C1 and A1 by a recorded draw', async () => {
    const r = await run()
    const tie = r.tieBreaks.find((t) => t.kind === 'election_order')
    expect(tie).toBeDefined()
    expect(tie!.candidates.sort()).toEqual(['A1', 'C1'])
    expect(['countback', 'seeded_draw']).toContain(tie!.method)
  })

  it('elects both over-quota candidates on first preferences, in one round', async () => {
    const r = await run()
    expect(r.rounds[0]!.elected.map((e) => e.candidateId).sort()).toEqual(['A1', 'C1'])
  })

  it('uses the IGM transfer value 49/110, truncated', async () => {
    // surplus 49 over 110 PAPERS = 0.4454545..., truncated to 5dp.
    const r = await run()
    for (const e of r.rounds[0]!.elected) expect(e.transferValue).toBe('0.44545')
  })

  it('lands A1\'s surplus on A2 and P1 in the documented proportions', async () => {
    // The walkthrough's "44 to A2, 4 to P1" are truncated displays of
    // 100 x 0.44545 and 10 x 0.44545 (P1 also holds 20 first preferences).
    const r1 = (await run()).rounds[0]!
    const at = (id: string) => r1.counts.find((c) => c.candidateId === id)!.votes
    expect(at('A2')).toBe('44.54500')
    expect(at('P1')).toBe('24.45450')
    expect(at('C2')).toBe('48.99950') // C1's surplus, entirely to C2
  })

  it('conserves every vote across the whole count', async () => {
    const r = await run()
    for (const rd of r.rounds) {
      const total =
        rd.counts.reduce((s, c) => s + BigInt(c.votes.replace('.', '')), 0n) +
        BigInt(rd.nonTransferable.replace('.', ''))
      expect(total).toBe(24_000_000n) // 240 ballots at 5dp
    }
  })
})
