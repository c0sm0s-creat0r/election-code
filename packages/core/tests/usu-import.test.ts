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
})
