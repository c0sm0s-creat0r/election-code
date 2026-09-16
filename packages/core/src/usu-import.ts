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
}

const HEADER_COLUMNS = 28
const SHIFT_AT = 10 // an extra source-type-text field appears here

function parseCsvLine(line: string): string[] {
  const out: string[] = []
  let cur = ''
  let inQuotes = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!
    if (inQuotes) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++ }
      else if (ch === '"') inQuotes = false
      else cur += ch
    } else if (ch === '"') inQuotes = true
    else if (ch === ',') { out.push(cur); cur = '' }
    else cur += ch
  }
  out.push(cur)
  return out
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
 * Only four columns are imported. Email, membership dates and the other two
 * identifiers are deliberately discarded: the roll holds an id and a name
 * and nothing else.
 */
export function parseUsuExport(csv: string): ImportResult {
  const lines = csv.split(/\r?\n/).filter((l) => l.trim().length > 0)
  const headerLine = lines[0]
  if (!headerLine) throw new Error('parseUsuExport: file has no header row')

  const header = parseCsvLine(headerLine)
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

  for (const line of lines.slice(1)) {
    const cells = parseCsvLine(line)
    const rowShifted = cells.length > HEADER_COLUMNS
    if (rowShifted) shifted = true

    const at = (i: number) => cells[i >= SHIFT_AT && rowShifted ? i + 1 : i]?.trim() ?? ''

    const usuId = at(netIdAt)
    if (!usuId) continue

    members.push({
      usuId,
      firstName: at(firstAt),
      lastName: at(lastAt),
      eligible: at(leftAt) !== '1',
    })
  }

  const eligible = members.filter((m) => m.eligible).length
  return { members, eligible, excluded: members.length - eligible, shifted }
}
