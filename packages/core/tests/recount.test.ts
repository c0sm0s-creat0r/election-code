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
