export type RollMember = {
  usuId: string
  firstName: string
  lastName: string
  eligible: boolean
}

export type ImportResult = {
  members: RollMember[]
  eligible: number
  excluded: number
  /** true when the export had the 29-column defect */
  shifted: boolean
  /**
   * Rows present in the file but not imported: a blank Net Id, or a field
   * count that is neither 28 nor 29 (malformed - realignment cannot be
   * safely guessed, so the row is dropped rather than misread).
   */
  skipped: number
}

const HEADER_COLUMNS = 28
const SHIFT_AT = 10 // an extra source-type-text field appears here

/**
 * Parse an entire CSV document into rows of fields.
 *
 * Quote state is tracked across the WHOLE character stream, not line by
 * line - a quoted field containing a literal newline (plausible in the
 * free-text "Officer  Notes" column) does not fracture one logical row
 * into fragments. A row ends only on a newline (\r\n or bare \n)
 * encountered OUTSIDE quotes. `""` inside a quoted field is an escaped
 * literal quote. A trailing newline at end of file does not produce an
 * extra empty row.
 *
 * Throws if the file ends while still inside a quoted field: an unclosed
 * quote can silently merge multiple logical rows into one oversized field,
 * which would otherwise be reported as a single malformed/skipped row
 * while the true number of lost members goes uncounted. A corrupt file is
 * refused outright rather than partially imported.
 */
function parseCsvRows(csv: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let cur = ''
  let inQuotes = false
  let started = false // true once the current (unterminated) row has any content

  const n = csv.length
  let i = 0
  while (i < n) {
    const ch = csv[i]!
    if (inQuotes) {
      if (ch === '"' && csv[i + 1] === '"') { cur += '"'; i += 2; continue }
      if (ch === '"') { inQuotes = false; i++; continue }
      cur += ch
      i++
      continue
    }
    if (ch === '"') { inQuotes = true; started = true; i++; continue }
    if (ch === ',') { row.push(cur); cur = ''; started = true; i++; continue }
    if (ch === '\r' && csv[i + 1] === '\n') {
      row.push(cur)
      rows.push(row)
      row = []
      cur = ''
      started = false
      i += 2
      continue
    }
    if (ch === '\n') {
      row.push(cur)
      rows.push(row)
      row = []
      cur = ''
      started = false
      i++
      continue
    }
    cur += ch
    started = true
    i++
  }

  // Tracking quotes across the whole file (rather than line by line) is
  // what lets a genuine embedded newline survive intact - but it also means
  // a single stray unescaped `"` no longer runs away to the end of one
  // line; it swallows every following newline and row until another `"`
  // closes it, or until EOF. If we reach EOF still inQuotes, rows have
  // already been silently merged and any field count / skipped count
  // computed from them would understate how many members were actually
  // lost. Refuse to guess: the whole file is untrustworthy.
  if (inQuotes) {
    throw new Error(
      'parseUsuExport: unterminated quoted field — the export is corrupt. ' +
        'No roll was imported.',
    )
  }

  // flush a final row that wasn't terminated by a trailing newline
  if (started || cur.length > 0 || row.length > 0) {
    row.push(cur)
    rows.push(row)
  }

  return rows
}

/**
 * Parse a USU member export into roll entries.
 *
 * The export is malformed: 28 header columns but 29 per data row, with an
 * unnamed source-type-text field at index 10 shifting everything after it.
 * Net Id, First Name and Last Name sit BEFORE the shift and parse either
 * way. "Left Group" sits after it - read from the header position it is 0
 * for every row, which silently grants departed members voting rights.
 *
 * The shift offset is derived from each row's own field count
 * (`cells.length - HEADER_COLUMNS`), not assumed to always be exactly one.
 * A row whose field count is neither 28 nor 29 is malformed - its
 * alignment cannot be safely guessed, so it is skipped and counted rather
 * than silently misread.
 *
 * Only four columns are imported. Email, membership dates and the other two
 * identifiers are deliberately discarded: the roll holds an id and a name
 * and nothing else.
 */
export function parseUsuExport(csv: string): ImportResult {
  const rows = parseCsvRows(csv).filter((r) => !(r.length === 1 && (r[0] ?? '').trim() === ''))
  const header = rows[0]
  if (!header) throw new Error('parseUsuExport: file has no header row')

  const idx = (name: string) => header.indexOf(name)

  const netIdAt = idx('Net Id')
  const firstAt = idx('First Name')
  const lastAt = idx('Last Name')
  const leftAt = idx('Left Group')
  if (netIdAt < 0 || firstAt < 0 || lastAt < 0 || leftAt < 0) {
    throw new Error('parseUsuExport: header is missing a required column')
  }

  const members: RollMember[] = []
  let shifted = false
  let skipped = 0

  for (const cells of rows.slice(1)) {
    const offset = cells.length - HEADER_COLUMNS

    if (offset !== 0 && offset !== 1) {
      // neither 28 nor 29 fields: alignment cannot be safely guessed
      skipped++
      continue
    }
    if (offset === 1) shifted = true

    const at = (i: number) => cells[i >= SHIFT_AT ? i + offset : i]?.trim() ?? ''

    const usuId = at(netIdAt)
    if (!usuId) {
      skipped++
      continue
    }

    members.push({
      usuId,
      firstName: at(firstAt),
      lastName: at(lastAt),
      eligible: at(leftAt) !== '1',
    })
  }

  const eligible = members.filter((m) => m.eligible).length
  return { members, eligible, excluded: members.length - eligible, shifted, skipped }
}
