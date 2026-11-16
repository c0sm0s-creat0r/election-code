import { describe, it, expect } from 'vitest'
import { count } from '../src/index.js'
import { recount, toBallotsCsv, toCandidatesCsv } from '../src/recount.js'

const ARGS = [1, 'e1', 'ee'.repeat(8)] as const

// 4 x a>b, 4 x b>a, 2 x c>a
const ballots = [
  ...Array.from({ length: 4 }, (_, i) => ({ id: `b${i + 1}`, preferences: ['a', 'b'], voided: false })),
  ...Array.from({ length: 4 }, (_, i) => ({ id: `b${i + 5}`, preferences: ['b', 'a'], voided: false })),
  ...Array.from({ length: 2 }, (_, i) => ({ id: `b${i + 9}`, preferences: ['c', 'a'], voided: false })),
]
const named = (a: string, b = 'Bo') => [
  { id: 'a', name: a }, { id: 'b', name: b }, { id: 'c', name: 'Cass' },
]

describe('recount: round trip through the CSV producers', () => {
  it.each([
    ['plain names', named('Alex')],
    ['a comma', named('Smith, John')],
    ['a quote', named('O"Bo')],
    ['a newline', named('Smith\nJones')],
    ['newline, comma and quote together', named('Smith\n, "Jones"')],
    ['a newline in a later row', named('Alex', 'Bo\nJr')],
    ['a padded name', named('  Alex  ')],
    // trimming would make '  a  ' collide with 'a'
    ['a padded id', [...named('Alex'), { id: '  a  ', name: 'Padded' }]],
  ])('matches a direct count with %s', async (_label, candidates) => {
    const viaCsv = await recount(toBallotsCsv(ballots), toCandidatesCsv(candidates), ...ARGS)
    const direct = await count({
      candidates, ballots, seats: 1, electionId: 'e1', ballotsSha256: 'ee'.repeat(8),
    })
    expect(viaCsv).toEqual(direct)
  })
})

describe('recount: blank rows', () => {
  const candidatesCsv = toCandidatesCsv(named('Alex'))
  const ballotsCsv = toBallotsCsv(ballots)
  // insert a row after the first record
  const withRow = (csv: string, row: string) => {
    const lines = csv.split('\n')
    lines.splice(2, 0, row)
    return lines.join('\n')
  }

  // A phantom ballot would move the quota; a phantom candidate would join the table.
  it.each([
    ['an empty line', ''],
    ['a whitespace-only line', '   '],
    ['a bare comma', ','],
    ['empty quoted fields', '"","",""'],
    ['whitespace and empty fields', '"  ",""'],
  ])('drops %s from either file', async (_label, row) => {
    const clean = await recount(ballotsCsv, candidatesCsv, ...ARGS)
    const dirty = await recount(withRow(ballotsCsv, row), withRow(candidatesCsv, row), ...ARGS)
    expect(dirty).toEqual(clean)
  })
})

// recount reads only this library's output, so any of these means the file
// was truncated or edited.
describe('recount: fails closed', () => {
  const C = 'candidate_id,name\n"a","Alex"\n"b","Bo"\n'
  const B = 'ballot_id,preferences,voided\n"x1","a","0"\n"x2","b","0"\n'
  const cand = (...rows: string[]) => ['candidate_id,name', ...rows, ''].join('\n')
  const bal = (...rows: string[]) => ['ballot_id,preferences,voided', ...rows, ''].join('\n')

  it.each([
    ['whitespace-only candidate id', B, cand('"a","Alex"', '"   ","Bo"'), 'row 3 has an empty candidate id'],
    ['empty ballot id', bal('"x1","a","0"', ',"b","0"'), C, 'row 3 has an empty ballot id'],
    ['too many fields', B, cand('"a","Alex","extra"', '"b","Bo"'), 'row 2 has 3 field(s), expected 2'],
    ['too few fields', bal('"x1","a","0"', '"x2"'), C, 'row 3 has 1 field(s), expected 3'],
    // without the header check the first ballot would be eaten
    ['missing ballot header', '"x1","a","0"\n"x2","b","0"\n', C, 'expected a "ballot_id,preferences,voided" header'],
    // a file without `voided` cannot be checked against the seal
    ['two-column ballot file', 'ballot_id,preferences\n"x1","a"\n', C, 'expected a "ballot_id,preferences,voided" header'],
    ['wrong candidate header', B, 'id,name\n"a","Alex"\n"b","Bo"\n', 'expected a "candidate_id,name" header'],
    ['empty file', B, '', 'expected a "candidate_id,name" header'],
    ['duplicate candidate id', B, cand('"a","Alex"', '"b","Bo"', '"a","Again"'), 'row 4 repeats candidate id "a"'],
    ['duplicate ballot id', bal('"x1","a","0"', '"x1","b","0"'), C, 'row 3 repeats ballot id "x1"'],
    // a deleted candidate line must not silently exhaust papers
    ['unknown preference', bal('"x1","a","0"', '"x2","z|b","0"'), C, 'row 3 lists preference "z"'],
    ['empty preference', bal('"x1","a","0"', '"x2","a||b","0"'), C, 'row 3 has an empty preference'],
    ['repeated preference', bal('"x1","a","0"', '"x2","b|a|b","0"'), C, 'row 3 repeats preference "b"'],
    // would raise the quota while voting for nobody
    ['empty preference list', bal('"x1","a","0"', '"x2","","0"'), C, 'row 3 has an empty preference list'],
    ['unterminated quote', B, cand('"a","Alex', '"b","Bo"'), 'unterminated quoted field'],
    ['voided neither 0 nor 1', bal('"x1","a","maybe"'), C, 'row 2 has voided="maybe"'],
    // voided rows are not counted but are still validated
    ['unknown preference on a voided ballot', bal('"x1","a","0"', '"x2","ghost","1"'), C, 'row 3 lists preference "ghost"'],
    ['nothing but voided ballots', bal('"x1","a","1"'), C, 'every one of the 1 ballot(s) is voided'],
  ])('%s', async (_label, ballotsCsv, candidatesCsv, message) => {
    await expect(recount(ballotsCsv, candidatesCsv, ...ARGS)).rejects.toThrow(message)
  })
})

describe('toBallotsCsv', () => {
  it('emits a voided column', () => {
    const csv = toBallotsCsv([
      { id: 'b1', preferences: ['a', 'b'], voided: false },
      { id: 'b2', preferences: ['b', 'a'], voided: true },
    ])
    expect(csv).toBe('ballot_id,preferences,voided\n"b1","a|b","0"\n"b2","b|a","1"\n')
  })

  it("refuses a candidate id containing '|'", () => {
    // it would come back as two preferences
    expect(() => toBallotsCsv([{ id: 'x1', preferences: ['a|b', 'c'], voided: false }])).toThrow(
      /contains '\|'/,
    )
  })
})

describe('recount: voided ballots', () => {
  it('leaves them out of the count', async () => {
    const csv = toBallotsCsv([
      { id: 'b1', preferences: ['a'], voided: false },
      { id: 'b2', preferences: ['a'], voided: false },
      { id: 'b3', preferences: ['b'], voided: true },
    ])
    const r = await recount(csv, toCandidatesCsv(named('Alex')), ...ARGS)
    // 2 counted, not 3: floor(2/2)+1
    expect(r.quota).toBe('2.00000')
    expect(r.winners.map((w) => w.id)).toEqual(['a'])
  })
})
