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
    // irv.py eliminates all tied-lowest candidates at once with no safety check,
    // and declares a sole survivor without transferring. This count excludes one
    // at a time, so these cases differ.
    const acceptedDivergences = new Set([
      // c0/c1/c3/c4 tied on 11 (c2 leads on 14 of 58). irv.py drops all four
      // and c2 wins with no transfer. python=c2 ts=c3.
      71,
      // c1/c4/c5 tied on 5 (of 36), then c2/c3 tied on 10. irv.py drops each
      // group whole, leaving c0. python=c0 ts=c4.
      120,
      // c0/c2/c3 tied on 12 (c1 leads on 14 of 50). irv.py drops all three and
      // c1 wins on 28% of first preferences. python=c1 ts=c2.
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
    // Any other mismatch is a regression until shown otherwise.
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
