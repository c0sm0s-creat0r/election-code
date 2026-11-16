import type { Fixed } from './fixed.js'

/**
 * Bulk exclusion under the Senate safety condition: candidates go together
 * only while their combined total is below the next candidate's.
 * `maxExcludable` keeps enough candidates to fill the remaining seats.
 */
export function bulkExclusionSet(
  totals: { id: string; votes: Fixed }[],
  maxExcludable: number,
): string[] {
  if (totals.length === 0 || maxExcludable < 1) return []

  const sorted = [...totals].sort((a, b) =>
    a.votes === b.votes ? a.id.localeCompare(b.id) : a.votes < b.votes ? -1 : 1,
  )

  const chosen = [sorted[0]!.id]
  let running: Fixed = sorted[0]!.votes

  for (let i = 1; i < sorted.length - 1; i++) {
    if (chosen.length >= maxExcludable) break
    const next = sorted[i + 1]!.votes
    const candidate = sorted[i]!
    if (running + candidate.votes >= next) break
    chosen.push(candidate.id)
    running += candidate.votes
  }

  return chosen
}
