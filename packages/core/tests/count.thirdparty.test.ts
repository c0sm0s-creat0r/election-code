import { describe, it, expect } from 'vitest'
import { count } from '../src/count.js'
import fx from './fixtures/third-party/concretestv-simple-example.json' with { type: 'json' }

/**
 * A differential against ConcreteSTV — NOT a known-answer corpus.
 *
 * Read the honest limits before trusting this file:
 *
 *  - ConcreteSTV (github.com/AndrewConway/ConcreteSTV) is an independent
 *    implementation of the federal rules, including bug-compatible AEC2013 /
 *    AEC2016 / AEC2019 variants. Its results were used to find real defects in
 *    three federal Senate counts, so disagreeing with it is strong evidence we
 *    are wrong. It is still another implementation, not an authority's
 *    published count.
 *
 *  - No small officially-published IGM count exists to use instead. IGM is used
 *    only for federal Senate elections, so every real IGM count is a national
 *    contest; the smallest (ACT/NT, 2 senators) is ~300k ballots. Western
 *    Australia and NSW local government, the other Australian STV
 *    jurisdictions, both use WIGM — the same mismatch as Scotland.
 *
 *  - **This fixture does not discriminate IGM from WIGM.** Every paper in the
 *    round-1 surplus is at full value, and IGM and WIGM agree there. The one
 *    transfer with a mixed-weight pile is A2's, and A2 takes the final seat, so
 *    its surplus cannot change the outcome. What this pins is the quota, the
 *    election-at-quota behaviour, the exclusion order, exhaustion, and the
 *    winner set — not the surplus method itself. That gap is real and stated
 *    rather than papered over.
 *
 *  - ConcreteSTV stores above-the-line party tickets. Our model has no ATL/BTL
 *    concept, so each ticket is expanded to the preference list it stands for;
 *    the mapping is recorded per group in the fixture's `_from` fields.
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
    // Compared as a SET, deliberately. C1 and A1 both finish on 110 with an
    // identical surplus of 49, so which is elected first is a genuine
    // election_order tie — resolved by lot under the Act, and here by the
    // ballot-seeded draw. The order therefore varies with the election id
    // while the winner set does not, and asserting the order would pin an
    // arbitrary outcome as though it were the rule.
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
