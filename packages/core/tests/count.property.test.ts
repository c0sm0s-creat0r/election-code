import { describe, it, expect } from 'vitest'
import { count } from '../src/count.js'
import type { CountInput } from '../src/types.js'

/** Deterministic pseudo-random generator so failures are reproducible. */
function lcg(seed: number) {
  let s = seed
  return () => ((s = (s * 1103515245 + 12345) % 2147483648) / 2147483648)
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
    const shuffled = [...candidates].sort(() => rnd() - 0.5).map((c) => c.id)
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
  })
})
