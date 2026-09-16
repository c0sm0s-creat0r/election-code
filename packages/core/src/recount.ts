import { count } from './count.js'
import type { Candidate, CountBallot, CountResult } from './types.js'

/**
 * Parse a whole CSV document into rows of fields, honouring double-quoted
 * fields that may contain commas, `\r\n` or `\n`, and `""`-escaped quote
 * characters - a row only ends on a newline seen outside quotes.
 *
 * This has to be a single pass over the whole text rather than
 * split-then-parse-each-line: splitting on newlines first would cut a
 * quoted field that itself contains a newline mid-value, silently
 * truncating it and misaligning every row after it.
 *
 * This is deliberately small and local to the ballot/candidate export
 * format this library produces (two simple columns). It is the same shape
 * as the tokenizer in usu-import.ts, which exists to cope with a malformed
 * third-party export - a different input with different failure modes.
 * Written separately here on purpose; do not import or share it.
 */
function parseCsvRows(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let inQuotes = false
  let i = 0
  const n = text.length

  const endField = () => {
    row.push(field)
    field = ''
  }
  const endRow = () => {
    endField()
    rows.push(row)
    row = []
  }

  while (i < n) {
    const c = text[i]
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"'
          i += 2
        } else {
          inQuotes = false
          i++
        }
      } else {
        field += c
        i++
      }
      continue
    }
    if (c === '"') {
      inQuotes = true
      i++
    } else if (c === ',') {
      endField()
      i++
    } else if (c === '\n') {
      endRow()
      i++
    } else if (c === '\r' && text[i + 1] === '\n') {
      endRow()
      i += 2
    } else {
      field += c
      i++
    }
  }
  if (field !== '' || row.length > 0) {
    endRow()
  }

  // Drop lines that were entirely blank (a lone empty field), matching the
  // old behaviour of filtering out whitespace-only lines before parsing.
  return rows.filter((r) => !(r.length === 1 && r[0] === ''))
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
  const rows = (csv: string) => parseCsvRows(csv).slice(1)

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
