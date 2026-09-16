import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { parseUsuExport } from '../src/usu-import.js'

const csv = readFileSync(new URL('./fixtures/usu-sample.csv', import.meta.url), 'utf8')

describe('parseUsuExport', () => {
  it('detects the 29-column shift', () => {
    expect(parseUsuExport(csv).shifted).toBe(true)
  })

  it('reads Left Group from the SHIFTED position, not the header position', () => {
    // the bug this module exists to prevent: a naive parse reads 0 for every
    // row and grants departed members voting rights
    const r = parseUsuExport(csv)
    expect(r.excluded).toBe(2)
    expect(r.eligible).toBe(4)
  })

  it('uses Net Id as usuId', () => {
    const ada = parseUsuExport(csv).members.find((m) => m.firstName === 'Ada')!
    expect(ada.usuId).toBe('2400001') // Net Id, NOT User Identifier or Member Identifier
    expect(ada.usuId).toHaveLength(7)
  })

  it('marks departed members ineligible rather than dropping them', () => {
    const grace = parseUsuExport(csv).members.find((m) => m.firstName === 'Grace')!
    expect(grace.eligible).toBe(false)
  })

  it('imports no email or membership data', () => {
    const m = parseUsuExport(csv).members[0]!
    expect(Object.keys(m).sort()).toEqual(['eligible', 'firstName', 'lastName', 'usuId'])
  })

  it('handles a corrected 28-column export if USU ever fixes it', () => {
    const lines = csv.trim().split('\n')
    // drop the extra source-type-text field at index 10 from each data row
    const fixed = [
      lines[0]!,
      ...lines.slice(1).map((l) => {
        const parts = l.split('","')
        parts.splice(10, 1)
        return parts.join('","')
      }),
    ].join('\n')
    const r = parseUsuExport(fixed)
    expect(r.shifted).toBe(false)
    expect(r.excluded).toBe(2) // still correct
  })

  it('rejects a file with no header', () => {
    expect(() => parseUsuExport('')).toThrow(/header/i)
  })

  // --- regression coverage: quote-aware parsing must span the whole file,
  // not just a single line, and misaligned rows must be surfaced rather
  // than silently misread. ---

  const header =
    '"User Identifier","Net Id","Member Identifier","First Name","Last Name","Email","Year Of Graduation","Member Type","Officer","Source Type","Membership End Date","Signup Date","Membership Payments","Events Payments","Member Tags","Sub-Groups Tags","User Tags","Officer  Notes","Last Online iOS","Last Online Android","Unsubscribed from all emails","Left Group","Left Group Reason","Dalyell Status","First Aid Expiry","Online Module Expiry","RSA Expiry","Working with Children Expiry"'

  // A shifted (29-field) data row, matching the real defect shape, with the
  // "Officer  Notes" field (index 18 once shifted) set by the caller so
  // individual tests can inject special characters into it.
  const shiftedRow = (netId: string, first: string, last: string, officerNotes: string, leftGroup: string) =>
    [
      '"900001"', `"${netId}"`, '"13000001"', `"${first}"`, `"${last}"`,
      '"person@example.com"', '"-"', '""', '"Member"', '"0"', '"Web"',
      '"Joined a group"', '"12/31/2026"', '"1/1/2026 9:00:00 AM"', '"0"', '"0"',
      '"-"', '"-"', `"${officerNotes}"`, '"-"', '""', '""',
      `"${leftGroup}"`, '"0"', '""', '""', '""', '""', '""',
    ].join(',')

  it('does not fracture a logical row on a newline embedded inside quotes (the Critical regression)', () => {
    // A naive split(/\r?\n/) run BEFORE quote-aware parsing would cut this
    // single row into fragments, none of which reach the Left Group index,
    // so the departed member would come back eligible (silently granted a
    // ballot). Assert the opposite: the row survives intact.
    const notesWithNewline = 'Left\nafter dispute'
    const csvWithEmbeddedNewline = [header, shiftedRow('2500001', 'Grace', 'Departed', notesWithNewline, '1')].join(
      '\n',
    )

    const r = parseUsuExport(csvWithEmbeddedNewline)
    const member = r.members.find((m) => m.usuId === '2500001')

    expect(member).toBeDefined()
    expect(member!.eligible).toBe(false)
    expect(r.skipped).toBe(0)
  })

  it('handles a comma embedded inside a quoted field', () => {
    const csv = [header, shiftedRow('2500002', 'Comma', 'Field, Test', 'Note, with a comma', '0')].join('\n')
    const r = parseUsuExport(csv)
    const member = r.members.find((m) => m.usuId === '2500002')
    expect(member).toBeDefined()
    expect(member!.lastName).toBe('Field, Test')
    expect(member!.eligible).toBe(true)
  })

  it('handles an escaped double quote inside a quoted field', () => {
    const csv = [header, shiftedRow('2500003', 'Grace ""The Admiral""', 'Hopper', '-', '0')].join('\n')
    const r = parseUsuExport(csv)
    const member = r.members.find((m) => m.usuId === '2500003')
    expect(member).toBeDefined()
    expect(member!.firstName).toBe('Grace "The Admiral"')
  })

  it('handles CRLF line endings', () => {
    const csv = [
      header,
      shiftedRow('2500004', 'Carriage', 'Return', '-', '0'),
      shiftedRow('2500005', 'Line', 'Feed', '-', '1'),
    ].join('\r\n')
    const r = parseUsuExport(csv)
    expect(r.members).toHaveLength(2)
    expect(r.eligible).toBe(1)
    expect(r.excluded).toBe(1)
    expect(r.skipped).toBe(0)
  })

  it('counts a malformed row (wrong field count) as skipped rather than importing it', () => {
    const wellFormed = shiftedRow('2500006', 'Well', 'Formed', '-', '0')
    const malformedFields = wellFormed.split(',')
    malformedFields.splice(5, 2) // drop two fields so the row has neither 28 nor 29
    const malformed = malformedFields.join(',')

    const csv = [header, wellFormed, malformed].join('\n')
    const r = parseUsuExport(csv)

    expect(r.members).toHaveLength(1)
    expect(r.members[0]!.usuId).toBe('2500006')
    expect(r.skipped).toBe(1)
  })
})
