import { count } from './count.js'
import type { CountResult } from './types.js'

/**
 * Re-run a count from the exported CSVs alone - no database, no network.
 *
 * This is what makes the audit story concrete: a challenged result can be
 * recomputed in front of whoever is challenging it, from files they hold.
 */
export async function recount(
  ballotsCsv: string,
  candidatesCsv: string,
  seats: number,
  electionId: string,
  ballotsSha256: string,
): Promise<CountResult> {
  const rows = (csv: string) =>
    csv.split(/\r?\n/).filter((l) => l.trim()).slice(1)
      .map((l) => l.split(',').map((c) => c.replace(/^"|"$/g, '')))

  const candidates = rows(candidatesCsv).map(([id, name]) => ({
    id: id ?? '',
    name: name ?? '',
  }))
  const ballots = rows(ballotsCsv).map(([id, prefs]) => ({
    id: id ?? '',
    preferences: (prefs ?? '').split('|').filter(Boolean),
  }))

  return count({ candidates, ballots, seats, electionId, ballotsSha256 })
}
