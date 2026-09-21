import { count } from './count.js'
import type { Candidate, CountBallot, CountResult } from './types.js'

/**
 * A ballot as the export carries it: the count's view plus whether the ballot
 * was voided.
 *
 * `voided` is required rather than optional-defaulting-to-false on purpose.
 * This is the one format whose job is provenance — `ballots_sha256` is computed
 * over `id|preferences|voided` for every row — so a caller who omitted the
 * field would write `0` for a voided ballot and produce a file whose digest
 * silently disagrees with the seal it is supposed to prove.
 */
export type ExportBallot = CountBallot & { voided: boolean }

/**
 * A parsed CSV row, carrying the 1-based ordinal of the row as it appears
 * in the file (the header is row 1, and blank rows are counted before they
 * are dropped) so that an error can point an auditor at the offending line.
 */
type CsvRow = { n: number; fields: string[] }

function corrupt(detail: string): Error {
  return new Error(`recount: ${detail} — the CSV is corrupt. No count was performed.`)
}

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
function parseCsvRows(text: string): CsvRow[] {
  const rows: CsvRow[] = []
  let row: string[] = []
  let field = ''
  let inQuotes = false
  let i = 0
  let ordinal = 0
  const n = text.length

  const endField = () => {
    row.push(field)
    field = ''
  }
  const endRow = () => {
    endField()
    rows.push({ n: ++ordinal, fields: row })
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
  if (inQuotes) {
    // `recount` only ever reads this library's own export. An unterminated
    // quote there means the file was truncated or tampered with - exactly
    // the corruption a recount tool exists to catch. Fail closed rather
    // than silently absorbing the rest of the file into one field.
    throw new Error(
      'recount: unterminated quoted field — the CSV is truncated or corrupt. No count was performed.',
    )
  }
  if (field !== '' || row.length > 0) {
    endRow()
  }

  // Drop rows that carry no content at all - every field blank. This has to
  // look at *every* field, not just a single-field row: a bare `,` parses to
  // `['', '']`, and a row of empty quoted fields to `['', '', '']`. Letting
  // either through adds a phantom record, and for ballots that inflates
  // `ballots.length`, which feeds the Droop quota directly - a blank line in
  // the audit file would change who wins.
  //
  // Trimming here only decides whether a row is blank. Field values are
  // never trimmed or otherwise rewritten, so a candidate named '  Alex  '
  // survives with its spaces intact.
  return rows.filter((r) => !r.fields.every((f) => f.trim() === ''))
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
 * Produce the `ballot_id,preferences,voided` CSV this library's `recount` reads
 * back, with preferences pipe-joined inside one quoted field. The inverse of
 * the ballots half of `recount`'s input.
 *
 * **The `voided` column is what makes the seal reproducible from this file.**
 * `election_seal.ballots_sha256` is SHA-256 over `id|preferences|voided` for
 * every ballot sorted by id, so a holder of this export can recompute the
 * digest and confirm these are the sealed ballots *before* recounting them.
 * Without the column the recount proved the arithmetic and not the provenance.
 */
export function toBallotsCsv(ballots: ExportBallot[]): string {
  const lines = [BALLOT_HEADER.join(',')]
  for (const b of ballots) {
    for (const pref of b.preferences) {
      // Preferences are pipe-joined into one field, so an id containing '|'
      // splits into two on the way back and the file no longer describes the
      // election it came from. Refuse to write it rather than leave "do not
      // put a pipe in a candidate id" as a rule somebody downstream has to
      // know.
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
 * Take the data rows of one of our two tables, refusing anything whose shape
 * the writers above could not have produced.
 *
 * `recount` reads only this library's own output, so the header is fixed and
 * every data row has exactly as many fields as that header. A missing header
 * would make `slice(1)` eat a real record - for ballots, one fewer ballot
 * changes the quota - and a row with the wrong field count means the line was
 * hand-edited. Neither is something to guess past. That includes a two-column
 * ballot file from before the `voided` column existed: such a file cannot be
 * checked against a seal, so it is refused rather than read optimistically.
 */
function dataRows(csv: string, header: readonly string[]): CsvRow[] {
  const rows = parseCsvRows(csv)
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
 * Re-run a count from the exported CSVs alone - no database, no network.
 *
 * This is what makes the audit story concrete: a challenged result can be
 * recomputed in front of whoever is challenging it, from files they hold.
 *
 * Every refusal below shares one rationale. The only input `recount` ever
 * reads is this library's own export, written by `toCandidatesCsv` /
 * `toBallotsCsv` from records that `validateBallot` already accepted. So a
 * malformation here cannot have come from us: the file was truncated,
 * hand-edited or tampered with, which is precisely the situation a recount
 * exists to detect. Silently dropping such a row is the same error as
 * silently keeping it - both hand back a confident result computed from a
 * file that is not what it claims to be.
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
    // A repeat collapses in `count`'s maps but still appears twice in the round
    // table and the continuing-candidate count.
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
    // Only the two values this library writes. Anything else - 'true', 'yes',
    // '' - was hand-edited, and guessing at it would decide whether a ballot
    // counts.
    if (voidedField !== '0' && voidedField !== '1') {
      throw corrupt(`row ${row.n} has voided=${JSON.stringify(voidedField)}, expected "0" or "1"`)
    }
    if (seenBallotIds.has(id)) {
      throw corrupt(`row ${row.n} repeats ballot id ${JSON.stringify(id)}`)
    }
    seenBallotIds.add(id)

    // Not harmless: `ballots.length` is the Droop denominator, so a row ranking
    // nobody raises the quota while contributing to no candidate.
    if (prefsField === '') {
      throw corrupt(`row ${row.n} has an empty preference list`)
    }
    const preferences = prefsField.split('|')
    const seenPrefs = new Set<string>()
    for (const pref of preferences) {
      if (pref === '') {
        throw corrupt(`row ${row.n} has an empty preference`)
      }
      // `count` would treat an unknown preference as non-continuing and exhaust
      // the paper, so deleting one candidate line silently redistributes all of
      // their votes.
      if (!seenCandidateIds.has(pref)) {
        throw corrupt(`row ${row.n} lists preference ${JSON.stringify(pref)}, which is not a candidate`)
      }
      if (seenPrefs.has(pref)) {
        throw corrupt(`row ${row.n} repeats preference ${JSON.stringify(pref)}`)
      }
      seenPrefs.add(pref)
    }

    // A voided ballot is validated like any other - it is part of the sealed
    // file, and a preference naming nobody means the file does not describe
    // this election whether that row counted or not - but it is not passed to
    // `count`. It stays in the box and out of the tally, exactly as the
    // database holds it.
    if (voidedField === '1') {
      voidedCount++
      continue
    }

    ballots.push({ id, preferences })
  }

  // The Droop quota divides by the number of counted ballots, so an empty box
  // is not a count with no winner - it is a file that cannot produce one.
  if (ballots.length === 0) {
    throw corrupt(
      voidedCount > 0
        ? `every one of the ${voidedCount} ballot(s) is voided, so there is nothing to count`
        : 'the ballot file has no ballots',
    )
  }

  return count({ candidates, ballots, seats, electionId, ballotsSha256 })
}
