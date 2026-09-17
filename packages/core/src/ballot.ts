export type BallotCheck = { ok: true } | { ok: false; reason: string }

/**
 * Senate-style minimum: rank at least as many candidates as there are seats.
 * Capped at the candidate count, because demanding 5 preferences in a
 * 4-candidate field is unsatisfiable.
 *
 * Floored at 1. Without the floor, `seats = 0` or an empty candidate list
 * collapses the minimum to 0 and `validateBallot([], [], 1)` returns ok - a
 * ballot that ranks nobody, accepted as valid. `count` then carries it as a
 * ballot for quota purposes while it votes for no one. Callers inside this
 * repo never pass those values, but this library is meant to be usable
 * standalone, so it refuses on its own rather than on their discipline.
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
  if (preferences.length > candidateIds.length) {
    return { ok: false, reason: 'More preferences than candidates.' }
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
