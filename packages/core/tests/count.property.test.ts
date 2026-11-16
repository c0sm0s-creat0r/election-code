import { describe, it, expect } from 'vitest'
import { count } from '../src/count.js'
import type { CountInput } from '../src/types.js'

/** Deterministic pseudo-random generator so failures are reproducible. */
function lcg(seed: number) {
  let s = seed
  return () => ((s = (s * 1103515245 + 12345) % 2147483648) / 2147483648)
}

/** Fisher-Yates on the same lcg. (`sort(() => rnd() - 0.5)` is not a shuffle.) */
function shuffle<T>(items: readonly T[], rnd: () => number): T[] {
  const out = [...items]
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1))
    const a = out[i]!
    out[i] = out[j]!
    out[j] = a
  }
  return out
}

/** '12.34567' -> 1234567n, so round tables compare exactly, never as floats. */
function fx(formatted: string): bigint {
  return BigInt(formatted.replace('.', ''))
}

function randomElection(seed: number): CountInput {
  const rnd = lcg(seed)
  const candidateCount = 2 + Math.floor(rnd() * 6)
  const candidates = Array.from({ length: candidateCount }, (_, i) => ({
    id: `c${i}`,
    name: `Candidate ${i}`,
  }))
  const seats = 1 + Math.floor(rnd() * Math.min(3, candidateCount))
  const ballotCount = Math.floor(rnd() * 60)
  const ballots = Array.from({ length: ballotCount }, (_, i) => {
    const shuffled = shuffle(candidates, rnd).map((c) => c.id)
    const depth = seats + Math.floor(rnd() * (candidateCount - seats + 1))
    return { id: `b${i}`, preferences: shuffled.slice(0, Math.max(seats, depth)) }
  })
  return { candidates, ballots, seats, electionId: `e${seed}`, ballotsSha256: 'aa'.repeat(8) }
}

describe('count - properties', () => {
  it('terminates and never exceeds the seat count, across 200 random elections', async () => {
    for (let seed = 1; seed <= 200; seed++) {
      const input = randomElection(seed)
      const r = await count(input)
      expect(r.winners.length).toBeLessThanOrEqual(input.seats)
      expect(new Set(r.winners.map((w) => w.id)).size).toBe(r.winners.length)
    }
  })

  it('fills every seat whenever there are enough candidates and ballots', async () => {
    for (let seed = 1; seed <= 200; seed++) {
      const input = randomElection(seed)
      if (input.ballots.length === 0) continue
      if (input.candidates.length < input.seats) continue
      const r = await count(input)
      expect(r.winners.length).toBe(input.seats)
    }
  })

  it('never lets the non-transferable total go down', async () => {
    // Votes only ever leave the count: by exhaustion or by truncation.
    for (let seed = 1; seed <= 200; seed++) {
      const r = await count(randomElection(seed))
      let previous = 0n
      for (const round of r.rounds) {
        const current = fx(round.nonTransferable)
        expect(current >= previous).toBe(true)
        previous = current
      }
    }
  })

  it('elects every winner either on quota or by the fill rule', async () => {
    // A seat is filled only at quota, or by the fill rule once the continuing
    // field has shrunk to the seats left.
    for (let seed = 1; seed <= 200; seed++) {
      const r = await count(randomElection(seed))
      const quota = fx(r.quota)
      const declared: string[] = []

      for (const [index, round] of r.rounds.entries()) {
        for (const e of round.elected) {
          declared.push(e.candidateId)
          const held = round.counts.find((c) => c.candidateId === e.candidateId)!
          // The pile is cut back to the quota at distribution, so the total at
          // election is the recorded votes plus the recorded surplus.
          const atElection = fx(held.votes) + fx(e.surplus)
          if (atElection >= quota) continue

          // below quota: only the fill rule, in the final round
          expect(e.surplus).toBe('0.00000')
          expect(e.transferValue).toBe('0.00000')
          expect(index).toBe(r.rounds.length - 1)
          expect(round.counts.some((c) => c.status === 'continuing')).toBe(false)
        }
      }

      // and every winner was declared exactly once, in some round
      expect(declared.sort()).toEqual(r.winners.map((w) => w.id).sort())
    }
  })

  it('never ends a round with a continuing candidate sitting on a quota', async () => {
    // A continuing candidate may sit at or above quota only after an exclusion
    // round, and is then elected at the next count. A round that elected and
    // distributed must leave nobody continuing on a quota (CEA s273(8)).
    for (let seed = 1; seed <= 200; seed++) {
      const r = await count(randomElection(seed))
      const quota = fx(r.quota)

      for (const [index, round] of r.rounds.entries()) {
        const stranded = round.counts.filter(
          (c) => c.status === 'continuing' && fx(c.votes) >= quota,
        )
        if (stranded.length === 0) continue

        const where = `seed ${seed}, round ${round.n}: ` +
          `${stranded.map((c) => `${c.candidateId}=${c.votes}`).join(', ')} >= ${r.quota}`

        // so this must have been an exclusion round
        expect(round.elected, where).toEqual([])

        // and the exclusion that put them there elects them at the next count
        const next = r.rounds[index + 1]
        expect(next).toBeDefined()
        for (const c of stranded) {
          expect(next!.elected.map((e) => e.candidateId)).toContain(c.candidateId)
        }
      }
    }
  })

  it('is deterministic - identical input gives identical output', async () => {
    for (let seed = 1; seed <= 50; seed++) {
      const input = randomElection(seed)
      const a = await count(input)
      const b = await count(input)
      expect(JSON.stringify(a)).toBe(JSON.stringify(b))
    }
  })

  it('is independent of ballot ordering', async () => {
    for (let seed = 1; seed <= 50; seed++) {
      const input = randomElection(seed)
      const reversed = { ...input, ballots: [...input.ballots].reverse() }
      const a = await count(input)
      const b = await count(reversed)
      expect(a.winners.map((w) => w.id)).toEqual(b.winners.map((w) => w.id))
      expect(JSON.stringify(a)).toBe(JSON.stringify(b))
    }
  })
})

describe('count - edge cases', () => {
  const base = { electionId: 'e', ballotsSha256: 'bb'.repeat(8) }

  it('handles a single candidate and a single seat', async () => {
    const r = await count({
      ...base,
      candidates: [{ id: 'a', name: 'Alex' }],
      ballots: [{ id: 'b1', preferences: ['a'] }],
      seats: 1,
    })
    expect(r.winners.map((w) => w.id)).toEqual(['a'])
  })

  it('handles every ballot exhausting', async () => {
    const r = await count({
      ...base,
      candidates: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }, { id: 'c', name: 'C' }],
      ballots: [{ id: 'b1', preferences: ['a'] }, { id: 'b2', preferences: ['b'] }],
      seats: 1,
    })
    expect(r.winners).toHaveLength(1)
    expect(r.rounds.some((round) => round.excluded.length > 0)).toBe(true)
  })

  it('handles seats >= candidates by electing everyone', async () => {
    const r = await count({
      ...base,
      candidates: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }],
      ballots: [{ id: 'b1', preferences: ['a', 'b'] }],
      seats: 3,
    })
    expect(r.winners.map((w) => w.id).sort()).toEqual(['a', 'b'])
  })

  it('handles every candidate tied', async () => {
    const r = await count({
      ...base,
      candidates: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }, { id: 'c', name: 'C' }],
      ballots: [
        { id: '1', preferences: ['a'] },
        { id: '2', preferences: ['b'] },
        { id: '3', preferences: ['c'] },
      ],
      seats: 1,
    })
    expect(r.winners).toHaveLength(1)
    expect(r.tieBreaks.length).toBeGreaterThan(0)
    expect(['countback', 'seeded_draw']).toContain(r.tieBreaks[0]!.method)
  })
})
