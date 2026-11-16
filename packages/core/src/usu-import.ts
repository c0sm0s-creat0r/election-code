import { parseCsv } from './csv.js'

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
  /** True when the export had the 29-column defect. */
  shifted: boolean
  /** Rows dropped: blank Net Id, or a field count that is neither 28 nor 29. */
  skipped: number
}

const HEADER_COLUMNS = 28
const SHIFT_AT = 10 // an extra source-type-text field appears here

/**
 * Parse a USU member export into roll entries.
 *
 * The export has 28 header columns but 29 per data row: an unnamed field at
 * index 10 shifts the rest. Read at its header position, "Left Group" is 0
 * for every row, which would give departed members a vote. The offset comes
 * from each row's field count. Rows that are neither 28 nor 29 wide are
 * skipped and counted.
 *
 * Keeps id, names and eligibility. Discards email and everything else.
 */
export function parseUsuExport(csv: string): ImportResult {
  const parsed = parseCsv(csv)
  // Rows have merged, and `skipped` would undercount.
  if (!parsed) {
    throw new Error(
      'parseUsuExport: unterminated quoted field — the export is corrupt. ' +
        'No roll was imported.',
    )
  }
  const rows = parsed.filter((r) => !(r.length === 1 && (r[0] ?? '').trim() === ''))
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
