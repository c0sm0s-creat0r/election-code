import { describe, it, expect } from 'vitest'
import { count } from '../src/count.js'
import cases from './fixtures/irv-cases.json' with { type: 'json' }

type Case = {
  candidates: { id: string; name: string }[]
  ballots: string[][]
  winner: string | null
}

describe('differential vs legacy irv.py at seats = 1', () => {
  it('agrees with the old winner wherever the old code produced one', async () => {
    // irv.py's only elimination rule is "wipe out every tied-lowest
    // candidate in one round" (backend/irv.py, to_eliminate = [... votes ==
    // min_votes]), with no safety check and no per-candidate tie-break. When
    // that tied group is small it just skips a round; when it happens to be
    // every candidate but one, irv.py's "remaining == 1" shortcut declares
    // the survivor the winner immediately, without ever transferring the
    // group's preferences. The new count instead excludes tied-lowest
    // candidates one at a time via bulkExclusionSet's safety condition
    // (src/exclusion.ts) plus a per-round tie-break (src/count.ts), which
    // performs the transfers irv.py skipped and can legitimately land on a
    // different winner. This is exactly the "two intended differences"
    // described in the task brief (the tie bug and the bulk-exclusion
    // safety condition are the same code path in irv.py); traced by hand
    // for each case below and recorded in task-10-report.md.
    const acceptedDivergences = new Set([
      // Round 1: c0/c1/c3/c4 tied at 11 votes (c2 leads at 14 of 58). irv.py
      // eliminates all four simultaneously, leaving c2 as sole survivor and
      // declaring it the winner without any transfer. The new count
      // excludes one of the four per round (tie-break: seeded draw), and
      // three rounds of transfers later c3 reaches quota. python=c2 ts=c3.
      71,
      // Round 1: c1/c4/c5 tied at 5 (of 36); irv.py wipes all three at
      // once. Round 2 (python): c2/c3 tied at 10, wiped together, leaving
      // c0 as sole survivor -> winner c0, again with no transfer. The new
      // count resolves each tie one candidate at a time and, after
      // transfers, c4 reaches quota. python=c0 ts=c4.
      120,
      // Round 1: c0/c2/c3 tied at 12 (c1 leads at 14 of 50). irv.py
      // eliminates all three at once, leaving c1 as sole survivor and
      // declaring it the winner immediately -- despite c1 holding only 28%
      // of first preferences, no transfer ever happens. The new count
      // excludes one tied candidate per round and, three rounds of
      // transfers later, c2 reaches quota exactly (26 of 50). python=c1
      // ts=c2.
      179,
    ])

    const mismatches: string[] = []
    for (const [i, c] of (cases as Case[]).entries()) {
      if (c.winner === null) continue
      if (acceptedDivergences.has(i)) continue
      const r = await count({
        candidates: c.candidates,
        ballots: c.ballots.map((preferences, j) => ({ id: `b${j}`, preferences })),
        seats: 1,
        electionId: `case-${i}`,
        ballotsSha256: 'cc'.repeat(8),
      })
      if (r.winners[0]?.id !== c.winner) {
        mismatches.push(`case ${i}: python=${c.winner} ts=${r.winners[0]?.id}`)
      }
    }
    // Any mismatch is either a real regression or a case where irv.py's
    // missing bulk-exclusion safety test changed the outcome. Investigate
    // each one before accepting it.
    expect(mismatches).toEqual([])
  })

  it('produces a winner for cases where irv.py returned none', async () => {
    const noWinner = (cases as Case[]).filter((c) => c.winner === null)
    expect(noWinner.length).toBeGreaterThan(0) // the tie bug must be represented
    for (const [i, c] of noWinner.entries()) {
      const r = await count({
        candidates: c.candidates,
        ballots: c.ballots.map((preferences, j) => ({ id: `b${j}`, preferences })),
        seats: 1,
        electionId: `tie-${i}`,
        ballotsSha256: 'dd'.repeat(8),
      })
      expect(r.winners).toHaveLength(1)
    }
  })
})
