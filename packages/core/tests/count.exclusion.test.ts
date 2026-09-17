import { describe, it, expect } from 'vitest'
import { count } from '../src/count.js'

const ballots = (spec: [string[], number][]) =>
  spec.flatMap(([prefs, n]) =>
    Array.from({ length: n }, (_, i) => ({ id: `${prefs.join('')}-${i}`, preferences: prefs })),
  )

describe('count - exclusions', () => {
  it('runs a full instant-runoff and transfers preferences', async () => {
    // a=4, b=4, c=2. Nobody has 6 (quota). c excluded, its 2 go to a -> a=6.
    const r = await count({
      candidates: [
        { id: 'a', name: 'Alex' },
        { id: 'b', name: 'Bo' },
        { id: 'c', name: 'Cass' },
      ],
      ballots: ballots([[['a'], 4], [['b'], 4], [['c', 'a'], 2]]),
      seats: 1,
      electionId: 'e1',
      ballotsSha256: 'deadbeef00000000',
    })
    expect(r.winners.map((w) => w.id)).toEqual(['a'])
    expect(r.rounds.flatMap((x) => x.excluded).map((e) => e.candidateId)).toContain('c')
  })

  it('resolves a two-way tie instead of returning no winner', async () => {
    // THE irv.py BUG: 5-5 eliminated both and returned winner: null
    const r = await count({
      candidates: [{ id: 'a', name: 'Alex' }, { id: 'b', name: 'Bo' }],
      ballots: ballots([[['a'], 5], [['b'], 5]]),
      seats: 1,
      electionId: 'e1',
      ballotsSha256: 'deadbeef00000000',
    })
    expect(r.winners).toHaveLength(1)
    expect(r.tieBreaks).toHaveLength(1)
    expect(r.tieBreaks[0]!.method).toBe('seeded_draw')
  })

  it('honours an officer override of a tie-break', async () => {
    const args = {
      candidates: [{ id: 'a', name: 'Alex' }, { id: 'b', name: 'Bo' }],
      ballots: ballots([[['a'], 5], [['b'], 5]]),
      seats: 1,
      electionId: 'e1',
      ballotsSha256: 'deadbeef00000000',
    }
    const natural = await count(args)
    // NOTE: this deliberately differs from the original brief, which
    // overrode with the complement of the natural winner. That was a
    // tautology and reviewed/accepted as a bug in the brief, not this test
    // — do not "restore" it. The exclusion tie-break's resolved value IS the excluded candidate
    // (see count.ts: `toExclude = [await resolveTie(...)]`). To flip the
    // outcome we must override tb-1 with the NATURAL WINNER's id, forcing
    // that candidate to be excluded instead so the other one wins.
    // (Overriding with the complement-of-winner, i.e. the candidate who was
    // already excluded naturally, is a no-op with only two candidates.)
    const naturalWinner = natural.winners[0]!.id
    const overridden = await count({
      ...args,
      overrides: {
        'tb-1': { candidateId: naturalWinner, reason: 'Lots drawn in the room, as the constitution requires' },
      },
    })
    expect(overridden.tieBreaks[0]!.method).toBe('officer_override')
    expect(overridden.winners[0]!.id).not.toBe(natural.winners[0]!.id)
    // I3: the officer's own words reach the result document, rather than the
    // hardcoded string 'Officer override' that used to overwrite them.
    expect(overridden.tieBreaks[0]!.reason).toBe(
      'Lots drawn in the room, as the constitution requires',
    )
  })

  it('refuses an override whose tie-break id matches nothing in this count', async () => {
    // The realistic path: an officer overrides tb-2, a ballot is then voided
    // and the count re-run, and there is no longer a tb-2. Silently ignoring
    // it would report a result the officer never sanctioned while the audit
    // log claims an override was applied.
    await expect(
      count({
        candidates: [{ id: 'a', name: 'Alex' }, { id: 'b', name: 'Bo' }],
        ballots: ballots([[['a'], 5], [['b'], 5]]),
        seats: 1,
        electionId: 'e1',
        ballotsSha256: 'deadbeef00000000',
        overrides: { 'tb-7': { candidateId: 'a', reason: 'stale' } },
      }),
    ).rejects.toThrow('override for tie-break tb-7 was not applied')
  })

  it('refuses an override naming a candidate outside that tie', async () => {
    await expect(
      count({
        candidates: [
          { id: 'a', name: 'Alex' },
          { id: 'b', name: 'Bo' },
          { id: 'c', name: 'Cass' },
        ],
        // a wins outright; b and c tie for the exclusion that never happens
        ballots: ballots([[['a'], 6], [['b'], 2], [['c'], 2]]),
        seats: 1,
        electionId: 'e1',
        ballotsSha256: 'deadbeef00000000',
        overrides: { 'tb-1': { candidateId: 'a', reason: 'stale' } },
      }),
    ).rejects.toThrow(/tb-1/)
  })
})
