import { count } from './count.js'
import type { Candidate, CountBallot, CountResult } from './types.js'

/**
 * Split one CSV line into fields, honouring double-quoted fields that may
 * contain commas and `""`-escaped quote characters.
 *
 * This is deliberately small and local to the ballot/candidate export
 * format this library produces (two simple columns, no embedded newlines).
 * It is not the USU tokenizer in usu-import.ts, which exists to cope with a
 * malformed third-party export - a different input with different failure
 * modes. Keep them separate.
 */
function parseCsvLine(line: string): string[] {
  const fields: string[] = []
  let field = ''
  let inQuotes = false
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (inQuotes) {
      if (c === '"') {
        if (line[i + 1] === '"') {
          field += '"'
          i++
        } else {
          inQuotes = false
        }
      } else {
        field += c
      }
    } else if (c === '"') {
      inQuotes = true
    } else if (c === ',') {
      fields.push(field)
      field = ''
    } else {
      field += c
    }
  }
  fields.push(field)
  return fields
}

/** Quote a CSV field, escaping any `"` inside it as `""`. */
function csvField(value: string): string {
  return `"${value.replace(/"/g, '""')}"`
}

/**
 * Produce the `candidate_id,name` CSV this library's `recount` reads back.
 * The inverse of the candidates half of `recount`'s input.
 */
export function toCandidatesCsv(candidates: Candidate[]): string {
  const lines = ['candidate_id,name']
  for (const c of candidates) {
    lines.push(`${csvField(c.id)},${csvField(c.name)}`)
  }
  return lines.join('\n') + '\n'
}

/**
 * Produce the `ballot_id,preferences` CSV this library's `recount` reads
 * back, with preferences pipe-joined inside one quoted field. The inverse
 * of the ballots half of `recount`'s input.
 */
export function toBallotsCsv(ballots: CountBallot[]): string {
  const lines = ['ballot_id,preferences']
  for (const b of ballots) {
    lines.push(`${csvField(b.id)},${csvField(b.preferences.join('|'))}`)
  }
  return lines.join('\n') + '\n'
}

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
    csv.split(/\r?\n/).filter((l) => l.trim()).slice(1).map(parseCsvLine)

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
