/**
 * Single-pass CSV parse. Quoted fields may hold commas, newlines and `""`.
 * Returns every row, blank ones included, or null on an unterminated quote:
 * rows have merged, so no caller should trust the result.
 */
export function parseCsv(text: string): string[][] | null {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let inQuotes = false

  const endRow = () => {
    row.push(field)
    rows.push(row)
    row = []
    field = ''
  }

  for (let i = 0; i < text.length; i++) {
    const c = text[i]!
    if (inQuotes) {
      if (c !== '"') field += c
      else if (text[i + 1] === '"') { field += '"'; i++ }
      else inQuotes = false
    } else if (c === '"') inQuotes = true
    else if (c === ',') { row.push(field); field = '' }
    else if (c === '\n') endRow()
    else if (c === '\r' && text[i + 1] === '\n') { endRow(); i++ }
    else field += c
  }
  if (inQuotes) return null
  if (field !== '' || row.length > 0) endRow()
  return rows
}
