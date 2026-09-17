import { describe, it, expect } from 'vitest'
import { recount, toBallotsCsv, toCandidatesCsv } from '../src/recount.js'
import * as core from '../src/index.js'

describe('public surface', () => {
  it('exports what apps/api and the frontends need', () => {
    for (const name of [
      'count', 'validateBallot', 'minimumPreferences', 'droopQuota',
      'parseUsuExport', 'recount', 'toBallotsCsv', 'toCandidatesCsv',
      'format', 'VERSION', 'deriveSeed', 'seededDraw',
    ]) {
      expect(core).toHaveProperty(name)
    }
  })
})

describe('recount', () => {
  const candidatesCsv = 'candidate_id,name\na,Alex\nb,Bo\nc,Cass\n'
  const ballotsCsv = [
    'ballot_id,preferences',
    'b1,"a|b"', 'b2,"a|b"', 'b3,"a|b"', 'b4,"a|b"',
    'b5,"b|a"', 'b6,"b|a"', 'b7,"b|a"', 'b8,"b|a"',
    'b9,"c|a"', 'b10,"c|a"',
  ].join('\n')

  it('reproduces a count from exported CSVs alone', async () => {
    const r = await recount(ballotsCsv, candidatesCsv, 1, 'e1', 'ee'.repeat(8))
    expect(r.winners.map((w) => w.id)).toEqual(['a'])
  })

  it('gives the same result as counting the same data directly', async () => {
    const viaCsv = await recount(ballotsCsv, candidatesCsv, 1, 'e1', 'ee'.repeat(8))
    const direct = await core.count({
      candidates: [
        { id: 'a', name: 'Alex' }, { id: 'b', name: 'Bo' }, { id: 'c', name: 'Cass' },
      ],
      ballots: [
        ...Array.from({ length: 4 }, (_, i) => ({ id: `b${i + 1}`, preferences: ['a', 'b'] })),
        ...Array.from({ length: 4 }, (_, i) => ({ id: `b${i + 5}`, preferences: ['b', 'a'] })),
        ...Array.from({ length: 2 }, (_, i) => ({ id: `b${i + 9}`, preferences: ['c', 'a'] })),
      ],
      seats: 1,
      electionId: 'e1',
      ballotsSha256: 'ee'.repeat(8),
    })
    expect(viaCsv.winners).toEqual(direct.winners)
    expect(viaCsv.quota).toBe(direct.quota)
    expect(viaCsv).toEqual(direct)
  })

  it('round-trips through the CSV producers, including a comma and a quote in a name', async () => {
    const candidates = [
      { id: 'a', name: 'Smith, John' },
      { id: 'b', name: 'O"Bo' },
      { id: 'c', name: 'Cass' },
    ]
    const ballots = [
      ...Array.from({ length: 4 }, (_, i) => ({ id: `b${i + 1}`, preferences: ['a', 'b'] })),
      ...Array.from({ length: 4 }, (_, i) => ({ id: `b${i + 5}`, preferences: ['b', 'a'] })),
      ...Array.from({ length: 2 }, (_, i) => ({ id: `b${i + 9}`, preferences: ['c', 'a'] })),
    ]

    const producedCandidatesCsv = toCandidatesCsv(candidates)
    const producedBallotsCsv = toBallotsCsv(ballots)

    const viaCsv = await recount(producedBallotsCsv, producedCandidatesCsv, 1, 'e1', 'ee'.repeat(8))
    const direct = await core.count({
      candidates,
      ballots,
      seats: 1,
      electionId: 'e1',
      ballotsSha256: 'ee'.repeat(8),
    })

    expect(viaCsv.winners).toEqual(direct.winners)
    expect(viaCsv.quota).toBe(direct.quota)
    expect(viaCsv).toEqual(direct)
  })

  const stdBallots = [
    ...Array.from({ length: 4 }, (_, i) => ({ id: `b${i + 1}`, preferences: ['a', 'b'] })),
    ...Array.from({ length: 4 }, (_, i) => ({ id: `b${i + 5}`, preferences: ['b', 'a'] })),
    ...Array.from({ length: 2 }, (_, i) => ({ id: `b${i + 9}`, preferences: ['c', 'a'] })),
  ]

  it('round-trips a candidate name containing a newline, byte for byte', async () => {
    const candidates = [
      { id: 'a', name: 'Smith\nJones' },
      { id: 'b', name: 'Bo' },
      { id: 'c', name: 'Cass' },
    ]

    const producedCandidatesCsv = toCandidatesCsv(candidates)
    const producedBallotsCsv = toBallotsCsv(stdBallots)

    const viaCsv = await recount(producedBallotsCsv, producedCandidatesCsv, 1, 'e1', 'ee'.repeat(8))
    const direct = await core.count({
      candidates,
      ballots: stdBallots,
      seats: 1,
      electionId: 'e1',
      ballotsSha256: 'ee'.repeat(8),
    })

    expect(viaCsv.winners).toEqual([{ id: 'a', name: 'Smith\nJones' }])
    expect(viaCsv.winners[0]?.name).toBe('Smith\nJones')
    expect(viaCsv).toEqual(direct)
  })

  it('round-trips a name with a newline, a comma, and an escaped quote together', async () => {
    const trickyName = 'Smith\n, "Jones"'
    const candidates = [
      { id: 'a', name: trickyName },
      { id: 'b', name: 'Bo' },
      { id: 'c', name: 'Cass' },
    ]

    const producedCandidatesCsv = toCandidatesCsv(candidates)
    const producedBallotsCsv = toBallotsCsv(stdBallots)

    const viaCsv = await recount(producedBallotsCsv, producedCandidatesCsv, 1, 'e1', 'ee'.repeat(8))
    const direct = await core.count({
      candidates,
      ballots: stdBallots,
      seats: 1,
      electionId: 'e1',
      ballotsSha256: 'ee'.repeat(8),
    })

    expect(viaCsv.winners[0]?.name).toBe(trickyName)
    expect(viaCsv).toEqual(direct)
  })

  it('keeps rows aligned when a later candidate (not the first) has a newline in its name', async () => {
    const candidates = [
      { id: 'a', name: 'Alex' },
      { id: 'b', name: 'Bo\nJr' },
      { id: 'c', name: 'Cass' },
    ]

    const producedCandidatesCsv = toCandidatesCsv(candidates)
    const producedBallotsCsv = toBallotsCsv(stdBallots)

    const viaCsv = await recount(producedBallotsCsv, producedCandidatesCsv, 1, 'e1', 'ee'.repeat(8))
    const direct = await core.count({
      candidates,
      ballots: stdBallots,
      seats: 1,
      electionId: 'e1',
      ballotsSha256: 'ee'.repeat(8),
    })

    // 'c' (unaffected by the embedded newline in 'b') must still parse with
    // its own id and name, proving the row after the multi-line field did
    // not drift.
    const cRound = viaCsv.rounds[0]?.counts.find((r) => r.candidateId === 'c')
    expect(cRound?.name).toBe('Cass')
    const bRound = viaCsv.rounds[0]?.counts.find((r) => r.candidateId === 'b')
    expect(bRound?.name).toBe('Bo\nJr')
    expect(viaCsv).toEqual(direct)
  })

  it('throws on an unterminated quoted field in candidatesCsv rather than mangling rows', async () => {
    const badCandidatesCsv = 'candidate_id,name\n"a","Alex\n"b","Bo"\n"c","Cass"\n'

    await expect(
      recount(ballotsCsv, badCandidatesCsv, 1, 'e1', 'ee'.repeat(8)),
    ).rejects.toThrow(/unterminated|corrupt/i)
  })

  it('throws on an unterminated quoted field in ballotsCsv rather than mangling rows', async () => {
    const badBallotsCsv = 'ballot_id,preferences\n"b1","a\n"b2","b"\n'

    await expect(
      recount(badBallotsCsv, candidatesCsv, 1, 'e1', 'ee'.repeat(8)),
    ).rejects.toThrow(/unterminated|corrupt/i)
  })

  it('drops a whitespace-only line between two valid candidate rows instead of admitting a phantom candidate', async () => {
    const candidatesCsvWithBlankLine = 'candidate_id,name\n"a","Alex"\n   \n"b","Bo"\n'
    const minimalBallotsCsv = 'ballot_id,preferences\n"b1","a"\n"b2","b"\n'

    const r = await recount(minimalBallotsCsv, candidatesCsvWithBlankLine, 1, 'e1', 'ee'.repeat(8))

    expect(r.rounds[0]?.counts).toHaveLength(2)
    for (const c of r.rounds[0]?.counts ?? []) {
      expect(c.candidateId.trim()).not.toBe('')
    }
  })

  it('still drops a genuinely empty line between two valid candidate rows', async () => {
    const candidatesCsvWithEmptyLine = 'candidate_id,name\n"a","Alex"\n\n"b","Bo"\n'
    const minimalBallotsCsv = 'ballot_id,preferences\n"b1","a"\n"b2","b"\n'

    const r = await recount(minimalBallotsCsv, candidatesCsvWithEmptyLine, 1, 'e1', 'ee'.repeat(8))

    expect(r.rounds[0]?.counts).toHaveLength(2)
  })
})

/**
 * A blank row is a row where every field is blank - not only a row with one
 * blank field. The distinction decides an election: a bare `,` parses to
 * `['', '']`, and one extra ballot moves the Droop quota.
 */
describe('recount: blank rows with more than one field', () => {
  const twoCandidates = 'candidate_id,name\n"a","Alex"\n"b","Bo"\n'
  const threeBallots = 'ballot_id,preferences\n"x1","a"\n"x2","a"\n"x3","b"\n'

  it('does not let a bare comma row in ballotsCsv change the quota', async () => {
    // floor(3 / (1 + 1)) + 1 = 2. A phantom fourth ballot would make it 3,
    // which is the whole danger: a blank line in the audit file deciding
    // who won.
    const clean = await recount(threeBallots, twoCandidates, 1, 'e1', 'ee'.repeat(8))
    expect(clean.quota).toBe('2.00000')

    const withBareComma = 'ballot_id,preferences\n"x1","a"\n"x2","a"\n,\n"x3","b"\n'
    const dirty = await recount(withBareComma, twoCandidates, 1, 'e1', 'ee'.repeat(8))

    expect(dirty.quota).toBe('2.00000')
    expect(dirty.quota).toBe(clean.quota)
    expect(dirty).toEqual(clean)
  })

  it('does not let a bare comma row in candidatesCsv become a phantom candidate', async () => {
    const withBareComma = 'candidate_id,name\n"a","Alex"\n,\n"b","Bo"\n'

    const r = await recount(threeBallots, withBareComma, 1, 'e1', 'ee'.repeat(8))

    expect(r.rounds[0]?.counts).toHaveLength(2)
    expect(r.rounds[0]?.counts.map((c) => c.candidateId)).toEqual(['a', 'b'])
    for (const c of r.rounds[0]?.counts ?? []) {
      expect(c.candidateId.trim()).not.toBe('')
    }
  })

  it('drops a row of several empty quoted fields rather than refusing it', async () => {
    // All-blank means blank, whatever the field count - so this is dropped
    // as a blank line, not rejected as a three-field row.
    const withEmptyQuoted = 'candidate_id,name\n"a","Alex"\n"","",""\n"b","Bo"\n'

    const r = await recount(threeBallots, withEmptyQuoted, 1, 'e1', 'ee'.repeat(8))

    expect(r.rounds[0]?.counts.map((c) => c.candidateId)).toEqual(['a', 'b'])
  })

  it('drops a mixed whitespace-and-empty row in ballotsCsv without moving the quota', async () => {
    const withWhitespaceRow = 'ballot_id,preferences\n"x1","a"\n"  ",""\n"x2","a"\n"x3","b"\n'

    const r = await recount(withWhitespaceRow, twoCandidates, 1, 'e1', 'ee'.repeat(8))

    expect(r.quota).toBe('2.00000')
  })

  it('never trims a field it keeps: a candidate named "  Alex  " survives intact', async () => {
    const paddedName = '  Alex  '
    const candidates = [
      { id: 'a', name: paddedName },
      { id: 'b', name: 'Bo' },
    ]
    const ballots = [
      { id: 'x1', preferences: ['a'] },
      { id: 'x2', preferences: ['a'] },
      { id: 'x3', preferences: ['b'] },
    ]

    const viaCsv = await recount(
      toBallotsCsv(ballots), toCandidatesCsv(candidates), 1, 'e1', 'ee'.repeat(8),
    )
    const direct = await core.count({
      candidates, ballots, seats: 1, electionId: 'e1', ballotsSha256: 'ee'.repeat(8),
    })

    expect(viaCsv.winners[0]?.name).toBe(paddedName)
    expect(viaCsv.rounds[0]?.counts[0]?.name).toBe(paddedName)
    expect(viaCsv).toEqual(direct)
  })

  it('never trims an id it keeps: whitespace-padded ids stay distinct from bare ones', async () => {
    // '  a  ' and 'a' are different ids. If either were trimmed on the way
    // in they would collide, and the ballot for 'a' would land in the wrong
    // pile.
    const padded = 'candidate_id,name\n"  a  ","Padded"\n"a","Alex"\n'
    const ballots = 'ballot_id,preferences\n"x1","a"\n"x2","a"\n"x3","  a  "\n'

    const r = await recount(ballots, padded, 1, 'e1', 'ee'.repeat(8))

    expect(r.rounds[0]?.counts.map((c) => c.candidateId)).toEqual(['  a  ', 'a'])
    expect(r.winners[0]?.id).toBe('a')
  })
})

/**
 * Everything `recount` refuses. It reads only this library's own output, so
 * any of these means the file was truncated, hand-edited or tampered with -
 * and silently dropping such a row is the same error as silently keeping it.
 */
describe('recount: fails closed on a corrupt row', () => {
  const twoCandidates = 'candidate_id,name\n"a","Alex"\n"b","Bo"\n'
  const twoBallots = 'ballot_id,preferences\n"x1","a"\n"x2","b"\n'
  const args = [1, 'e1', 'ee'.repeat(8)] as const

  it('throws on a surviving row with an empty candidate id', async () => {
    const csv = 'candidate_id,name\n"a","Alex"\n,"Bo"\n'
    await expect(recount(twoBallots, csv, ...args)).rejects.toThrow(
      'recount: row 3 has an empty candidate id — the CSV is corrupt. No count was performed.',
    )
  })

  it('throws on a surviving row with a whitespace-only candidate id', async () => {
    const csv = 'candidate_id,name\n"a","Alex"\n"   ","Bo"\n'
    await expect(recount(twoBallots, csv, ...args)).rejects.toThrow(
      'recount: row 3 has an empty candidate id — the CSV is corrupt. No count was performed.',
    )
  })

  it('throws on a surviving row with an empty ballot id', async () => {
    const csv = 'ballot_id,preferences\n"x1","a"\n,"b"\n'
    await expect(recount(csv, twoCandidates, ...args)).rejects.toThrow(
      'recount: row 3 has an empty ballot id — the CSV is corrupt. No count was performed.',
    )
  })

  it('throws on a row with too many fields', async () => {
    const csv = 'candidate_id,name\n"a","Alex","extra"\n"b","Bo"\n'
    await expect(recount(twoBallots, csv, ...args)).rejects.toThrow(
      'recount: row 2 has 3 field(s), expected 2 — the CSV is corrupt. No count was performed.',
    )
  })

  it('throws on a row with too few fields', async () => {
    const csv = 'ballot_id,preferences\n"x1","a"\n"x2"\n'
    await expect(recount(csv, twoCandidates, ...args)).rejects.toThrow(
      'recount: row 3 has 1 field(s), expected 2 — the CSV is corrupt. No count was performed.',
    )
  })

  it('throws when the header row is missing, rather than eating the first record', async () => {
    // Without the header check, slice(1) would discard ballot x1 and the
    // quota would be computed from one ballot fewer.
    const headerless = '"x1","a"\n"x2","b"\n'
    await expect(recount(headerless, twoCandidates, ...args)).rejects.toThrow(
      'recount: expected a "ballot_id,preferences" header row — the CSV is corrupt. No count was performed.',
    )
  })

  it('throws on a wrong header in candidatesCsv', async () => {
    const csv = 'id,name\n"a","Alex"\n"b","Bo"\n'
    await expect(recount(twoBallots, csv, ...args)).rejects.toThrow(
      'recount: expected a "candidate_id,name" header row — the CSV is corrupt. No count was performed.',
    )
  })

  it('throws on an entirely empty CSV', async () => {
    await expect(recount(twoBallots, '', ...args)).rejects.toThrow(
      'recount: expected a "candidate_id,name" header row — the CSV is corrupt. No count was performed.',
    )
  })

  it('throws on a duplicate candidate id', async () => {
    const csv = 'candidate_id,name\n"a","Alex"\n"b","Bo"\n"a","Alex again"\n'
    await expect(recount(twoBallots, csv, ...args)).rejects.toThrow(
      'recount: row 4 repeats candidate id "a" — the CSV is corrupt. No count was performed.',
    )
  })

  it('throws on a duplicate ballot id', async () => {
    const csv = 'ballot_id,preferences\n"x1","a"\n"x1","b"\n'
    await expect(recount(csv, twoCandidates, ...args)).rejects.toThrow(
      'recount: row 3 repeats ballot id "x1" — the CSV is corrupt. No count was performed.',
    )
  })

  it('throws on a preference naming a candidate absent from candidatesCsv', async () => {
    // Deleting one candidate line would otherwise silently exhaust every
    // paper that ranked them, redistributing their votes with no warning.
    const csv = 'ballot_id,preferences\n"x1","a"\n"x2","z|b"\n'
    await expect(recount(csv, twoCandidates, ...args)).rejects.toThrow(
      'recount: row 3 lists preference "z", which is not a candidate — the CSV is corrupt. No count was performed.',
    )
  })

  it('throws on an empty preference token inside a list', async () => {
    const csv = 'ballot_id,preferences\n"x1","a"\n"x2","a||b"\n'
    await expect(recount(csv, twoCandidates, ...args)).rejects.toThrow(
      'recount: row 3 has an empty preference — the CSV is corrupt. No count was performed.',
    )
  })

  it('throws on a trailing pipe in a preference list', async () => {
    const csv = 'ballot_id,preferences\n"x1","a"\n"x2","b|"\n'
    await expect(recount(csv, twoCandidates, ...args)).rejects.toThrow(
      'recount: row 3 has an empty preference — the CSV is corrupt. No count was performed.',
    )
  })

  it('throws on a repeated preference within one ballot', async () => {
    const csv = 'ballot_id,preferences\n"x1","a"\n"x2","b|a|b"\n'
    await expect(recount(csv, twoCandidates, ...args)).rejects.toThrow(
      'recount: row 3 repeats preference "b" — the CSV is corrupt. No count was performed.',
    )
  })

  it('refuses to write a candidate id containing the preference separator', () => {
    // Preferences are pipe-joined into one CSV field, so an id with a '|' in
    // it splits into two on the way back and the file no longer describes the
    // election it came from. Enforced at the writer rather than left as a
    // naming rule somebody downstream has to know.
    expect(() => toBallotsCsv([{ id: 'x1', preferences: ['a|b', 'c'] }])).toThrow(
      /contains '\|'/,
    )
    expect(() => toBallotsCsv([{ id: 'x1', preferences: ['a', 'b'] }])).not.toThrow()
  })

  it('throws on a ballot whose preferences field is empty', async () => {
    // This test previously asserted the OPPOSITE, on the reasoning that "a
    // ballot ranking nobody is a well-formed empty list, not a malformation".
    // That reasoning was wrong, and wrong by recount's own standard. recount
    // reads nothing but this library's own export, written from records that
    // validateBallot already accepted - and validateBallot rejects an empty
    // list outright (spec section 3: a ballot must rank at least `seats`
    // candidates). So an empty preferences field is exactly as impossible as
    // 'a||b', which the neighbouring tests already require it to refuse.
    //
    // It is not inert, either: `count` divides by `ballots.length` for the
    // Droop quota, so each such row lifts the quota while putting no vote on
    // anybody. Five candidates, 2 seats, 23 ballots elects {a,b} at a quota of
    // 8; append four rows ranking nobody and the quota becomes 10 and the
    // winners become {b,d}. A hand-added blank field would change the result.
    const csv = 'ballot_id,preferences\n"x1","a"\n"x2","a"\n"x3",""\n'

    await expect(recount(csv, twoCandidates, ...args)).rejects.toThrow(
      'recount: row 4 has an empty preference list — the CSV is corrupt. No count was performed.',
    )
  })
})
