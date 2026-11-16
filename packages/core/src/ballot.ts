export type BallotCheck = { ok: true } | { ok: false; reason: string }

/**
 * Minimum preferences: the number of seats, capped at the candidate count.
 * Never below 1, so an empty ballot is invalid.
 */
export function minimumPreferences(seats: number, candidateCount: number): number {
  return Math.max(1, Math.min(seats, candidateCount))
}

export function validateBallot(
  preferences: string[],
  candidateIds: readonly string[],
  seats: number,
): BallotCheck {
  const min = minimumPreferences(seats, candidateIds.length)

  if (preferences.length < min) {
    return { ok: false, reason: `Rank at least ${min} candidate(s).` }
  }

  const known = new Set(candidateIds)
  for (const id of preferences) {
    if (!known.has(id)) return { ok: false, reason: `Unknown candidate: ${id}` }
  }

  const seen = new Set<string>()
  for (const id of preferences) {
    if (seen.has(id)) return { ok: false, reason: `Duplicate preference: ${id}` }
    seen.add(id)
  }

  return { ok: true }
}
