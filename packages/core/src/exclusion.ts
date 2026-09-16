import { type Fixed, ZERO } from './fixed.js'

/**
 * Bulk exclusion, as the Australian Senate count uses - WITH the safety
 * condition irv.py omits.
 *
 * Several candidates may be excluded together only while their combined
 * total stays below the next candidate's total. Otherwise the group could
 * include someone who, on transfers, would have overtaken that candidate.
 *
 * `maxExcludable` caps the set so the continuing field never drops below
 * the number of seats still to fill.
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

  return chosen.slice(0, maxExcludable)
}
