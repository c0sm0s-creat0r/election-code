import { count } from './count.js'
import { parseCsv } from './csv.js'
import type { Candidate, CountBallot, CountResult } from './types.js'

/**
 * A ballot as exported. `voided` is required: the seal digest covers
 * `id|preferences|voided`.
 */
export type ExportBallot = CountBallot & { voided: boolean }

/** `n` is the 1-based file row (the header is 1), for error messages. */
type CsvRow = { n: number; fields: string[] }

function corrupt(detail: string): Error {
  return new Error(`recount: ${detail} — the CSV is corrupt. No count was performed.`)
}

const CANDIDATE_HEADER = ['candidate_id', 'name'] as const
const BALLOT_HEADER = ['ballot_id', 'preferences', 'voided'] as const

function csvField(value: string): string {
  return `"${value.replace(/"/g, '""')}"`
}

export function toCandidatesCsv(candidates: Candidate[]): string {
  const lines = [CANDIDATE_HEADER.join(',')]
  for (const c of candidates) {
    lines.push(`${csvField(c.id)},${csvField(c.name)}`)
  }
  return lines.join('\n') + '\n'
}

/**
 * The ballot CSV that `recount` reads. Preferences are pipe-joined in one
 * field. The `voided` column lets a holder recompute `ballots_sha256` and
 * check the file against the seal.
 */
export function toBallotsCsv(ballots: ExportBallot[]): string {
  const lines = [BALLOT_HEADER.join(',')]
  for (const b of ballots) {
    for (const pref of b.preferences) {
      // A '|' in an id would come back as two preferences.
      if (pref.includes('|')) {
        throw new Error(
          `toBallotsCsv: candidate id ${JSON.stringify(pref)} contains '|', ` +
            `which is the preference separator, so it cannot round-trip ` +
            `through recount().`,
        )
      }
    }
    lines.push(`${csvField(b.id)},${csvField(b.preferences.join('|'))},${csvField(b.voided ? '1' : '0')}`)
  }
  return lines.join('\n') + '\n'
}

/**
 * Data rows of one of our own tables. Requires the exact header and field
 * count. A missing header would swallow a record; a two-column ballot file
 * cannot be checked against a seal.
 */
function dataRows(csv: string, header: readonly string[]): CsvRow[] {
  const parsed = parseCsv(csv)
  // We read only our own export, so this is truncation or tampering.
  if (!parsed) {
    throw new Error(
      'recount: unterminated quoted field — the CSV is truncated or corrupt. No count was performed.',
    )
  }
  // Drop all-blank rows: a phantom ballot would change the quota. Field values
  // are never trimmed.
  const rows: CsvRow[] = parsed
    .map((fields, i) => ({ n: i + 1, fields }))
    .filter((r) => !r.fields.every((f) => f.trim() === ''))
  const first = rows[0]
  const headerOk =
    first !== undefined &&
    first.fields.length === header.length &&
    header.every((h, i) => first.fields[i]?.trim() === h)
  if (!headerOk) {
    throw corrupt(`expected a "${header.join(',')}" header row`)
  }

  const body = rows.slice(1)
  for (const row of body) {
    if (row.fields.length !== header.length) {
      throw corrupt(
        `row ${row.n} has ${row.fields.length} field(s), expected ${header.length}`,
      )
    }
  }
  return body
}

/**
 * Re-run a count from the exported CSVs: no database, no network. Any
 * malformation means the file was truncated or edited, so `recount` throws.
 */
export async function recount(
  ballotsCsv: string,
  candidatesCsv: string,
  seats: number,
  electionId: string,
  ballotsSha256: string,
): Promise<CountResult> {
  const candidates: Candidate[] = []
  const seenCandidateIds = new Set<string>()
  for (const row of dataRows(candidatesCsv, CANDIDATE_HEADER)) {
    const id = row.fields[0] ?? ''
    const name = row.fields[1] ?? ''
    if (id.trim() === '') {
      throw corrupt(`row ${row.n} has an empty candidate id`)
    }
    // A repeat would appear twice in the round table.
    if (seenCandidateIds.has(id)) {
      throw corrupt(`row ${row.n} repeats candidate id ${JSON.stringify(id)}`)
    }
    seenCandidateIds.add(id)
    candidates.push({ id, name })
  }

  const ballots: CountBallot[] = []
  const seenBallotIds = new Set<string>()
  let voidedCount = 0
  for (const row of dataRows(ballotsCsv, BALLOT_HEADER)) {
    const id = row.fields[0] ?? ''
    const prefsField = row.fields[1] ?? ''
    const voidedField = row.fields[2] ?? ''
    if (id.trim() === '') {
      throw corrupt(`row ${row.n} has an empty ballot id`)
    }
    // Anything but the two values we write was hand-edited.
    if (voidedField !== '0' && voidedField !== '1') {
      throw corrupt(`row ${row.n} has voided=${JSON.stringify(voidedField)}, expected "0" or "1"`)
    }
    if (seenBallotIds.has(id)) {
      throw corrupt(`row ${row.n} repeats ballot id ${JSON.stringify(id)}`)
    }
    seenBallotIds.add(id)

    // A ballot ranking nobody would still raise the quota.
    if (prefsField === '') {
      throw corrupt(`row ${row.n} has an empty preference list`)
    }
    const preferences = prefsField.split('|')
    const seenPrefs = new Set<string>()
    for (const pref of preferences) {
      if (pref === '') {
        throw corrupt(`row ${row.n} has an empty preference`)
      }
      // `count` would exhaust the paper and redistribute a deleted candidate's votes.
      if (!seenCandidateIds.has(pref)) {
        throw corrupt(`row ${row.n} lists preference ${JSON.stringify(pref)}, which is not a candidate`)
      }
      if (seenPrefs.has(pref)) {
        throw corrupt(`row ${row.n} repeats preference ${JSON.stringify(pref)}`)
      }
      seenPrefs.add(pref)
    }

    // Voided ballots are validated like any other, then left out of the count.
    if (voidedField === '1') {
      voidedCount++
      continue
    }

    ballots.push({ id, preferences })
  }

  if (ballots.length === 0) {
    throw corrupt(
      voidedCount > 0
        ? `every one of the ${voidedCount} ballot(s) is voided, so there is nothing to count`
        : 'the ballot file has no ballots',
    )
  }

  return count({ candidates, ballots, seats, electionId, ballotsSha256 })
}
