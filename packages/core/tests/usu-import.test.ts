import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { parseUsuExport } from '../src/usu-import.js'

const csv = readFileSync(new URL('./fixtures/usu-sample.csv', import.meta.url), 'utf8')

describe('parseUsuExport', () => {
  it('detects the 29-column shift', () => {
    expect(parseUsuExport(csv).shifted).toBe(true)
  })

  it('reads Left Group from the SHIFTED position, not the header position', () => {
    // A naive parse reads 0 for every row and gives departed members a vote.
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

  // --- quote-aware parsing across the whole file, and misaligned rows ---

  const header =
    '"User Identifier","Net Id","Member Identifier","First Name","Last Name","Email","Year Of Graduation","Member Type","Officer","Source Type","Membership End Date","Signup Date","Membership Payments","Events Payments","Member Tags","Sub-Groups Tags","User Tags","Officer  Notes","Last Online iOS","Last Online Android","Unsubscribed from all emails","Left Group","Left Group Reason","Dalyell Status","First Aid Expiry","Online Module Expiry","RSA Expiry","Working with Children Expiry"'

  // A shifted (29-field) row with a caller-supplied "Officer  Notes" field.
  const shiftedRow = (netId: string, first: string, last: string, officerNotes: string, leftGroup: string) =>
    [
      '"900001"', `"${netId}"`, '"13000001"', `"${first}"`, `"${last}"`,
      '"person@example.com"', '"-"', '""', '"Member"', '"0"', '"Web"',
      '"Joined a group"', '"12/31/2026"', '"1/1/2026 9:00:00 AM"', '"0"', '"0"',
      '"-"', '"-"', `"${officerNotes}"`, '"-"', '""', '""',
      `"${leftGroup}"`, '"0"', '""', '""', '""', '""', '""',
    ].join(',')

  it('does not fracture a logical row on a newline embedded inside quotes (the Critical regression)', () => {
    // Splitting on newlines first would break this row, and the departed member
    // would come back eligible.
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

  // --- stray quotes: one swallows every following newline until it is closed ---

  it('throws when a quoted field is never closed before end of file', () => {
    // Still in quotes at EOF: reject the whole file.
    const unterminated = [header, shiftedRow('2500007', 'Never', 'Closed', '-', '0')]
      .join('\n')
      .replace('"Never"', '"Never') // drop this field's closing quote

    expect(() => parseUsuExport(unterminated)).toThrow(/unterminated|corrupt/i)
  })

  it('balanced stray quotes merge the rows between them into one skipped row', () => {
    // The quote opened on 2600002's row swallows two members' lines before a
    // second stray quote closes it. Nothing throws, and `skipped` is 1 though
    // three members are lost: it counts rows, not members.
    const csv = [
      header,
      shiftedRow('2600001', 'First', 'Good', '-', '0'),
      shiftedRow('2600002', 'Stray', 'Quote', '-', '0') + ',"opens',
      'PLAIN,2600003',
      'PLAIN,2600004',
      'closes",filler',
      shiftedRow('2600005', 'Last', 'Good', '-', '0'),
    ].join('\n')
    const r = parseUsuExport(csv)
    expect(r.members.map((m) => m.usuId)).toEqual(['2600001', '2600005'])
    expect(r.skipped).toBe(1)
  })
})
