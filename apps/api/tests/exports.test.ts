import { describe, it, expect, beforeEach } from 'vitest'
import { env } from 'cloudflare:test'
import {
  NEW_MEMBER, addDoorVoter, addGuest, api, castThree, checkIn, closeElection, getResult,
  setUp, sha256Hex, submitBallot, voidLiveBallot, voterSignIn, type Fixture,
} from './helpers.js'

let f: Fixture

beforeEach(async () => {
  f = await setUp()
  await castThree(f)
})

const get = (path: string) => api('GET', `/batches/${f.batchId}${path}`, f.officerCookie)
const forElection = (file: string, electionId = f.electionId) => get(`/elections/${electionId}/${file}`)
/** Header and rows of a CSV response. */
const csvOf = async (res: Response) => {
  const text = await res.text()
  const [header, ...rows] = text.trim().split('\n') as [string, ...string[]]
  return { text, header, rows }
}

describe('exports', () => {
  it('exports attendance as who voted, never what', async () => {
    await checkIn(f.batchId, f.doorCookie, '2400006')
    await closeElection(f)
    const res = await forElection('attendance.csv')
    expect(res.headers.get('content-disposition')).toMatch(/attachment; filename=/)
    expect(res.headers.get('content-type')).toMatch(/text\/csv/)
    const { text, header, rows } = await csvOf(res)
    expect(header).toBe('usu_id,first_name,last_name,voted_at,recast_count,added_at_door')
    expect(rows).toHaveLength(3)
    expect(text).toContain('2400001')
    expect(text).toContain('Lovelace')
    // checked in but never voted, so absent from the mark-off
    expect(text).not.toContain('2400006')
  })

  it('LETS A THIRD PARTY RECOMPUTE THE SEAL from the anonymous ballot export alone', async () => {
    // a voided ballot is still in the box, so still in the export
    await voidLiveBallot('2400004')
    await closeElection(f)
    const { text, header, rows } = await csvOf(await forElection('ballots.csv'))
    expect(header).toBe('ballot_id,preferences,voided')
    expect(rows).toHaveLength(3)
    for (const usuId of Object.keys(f.voterCookies)) expect(text).not.toContain(usuId)

    // parse the export as an outsider would, then rebuild the serialisation
    // spec §2 defines: `id|preferences|voided`, sorted by id
    const parsed = rows.map((line) => line.split('","').map((field) => field.replace(/^"|"$/g, '')) as [string, string, string])
    expect(parsed.map(([id]) => id)).toEqual(parsed.map(([id]) => id).sort())
    expect(parsed.map(([, , voided]) => voided).sort()).toEqual(['0', '0', '1'])
    const canonical = parsed
      .map(([id, prefs, voided]) => `${id}|${JSON.stringify(prefs.split('|').filter(Boolean))}|${Number(voided)}`)
      .join('\n')
    const seal = await env.DB.prepare('SELECT ballots_sha256 FROM election_seal').first<{ ballots_sha256: string }>()
    expect(await sha256Hex(canonical)).toBe(seal!.ballots_sha256)
  })

  it('refuses the ballots before close, the result before a count, and another batch\'s election', async () => {
    expect((await forElection('ballots.csv')).status).toBe(409)
    await closeElection(f)
    expect((await forElection('result.json')).status).toBe(409)
    expect((await forElection('ballots.csv', crypto.randomUUID())).status).toBe(404)
  })

  it('exports the candidate list beside the ballots, so a recount has both halves', async () => {
    await closeElection(f)
    const { text, header } = await csvOf(await forElection('candidates.csv'))
    expect(header).toBe('candidate_id,name')
    expect(text).toContain('Alex')
  })

  it('exports the sealed result with its tie-breaks', async () => {
    await closeElection(f)
    await getResult(f)
    expect(Object.keys(await (await forElection('result.json')).json() as object).sort()).toEqual([
      'ballot_count', 'ballots_sha256', 'closed_at', 'computed_at',
      'election', 'overridden', 'quota', 'rounds', 'tie_breaks', 'winners',
    ])
  })

  it('exports the whole batch attendance across elections, named for what it holds', async () => {
    await closeElection(f)
    const res = await get('/attendance.csv')
    expect(res.headers.get('content-disposition')).toContain(`voters-all-elections-${f.batchId}.csv`)
    const { text, header } = await csvOf(res)
    expect(header).toBe('election_id,election_name,usu_id,first_name,last_name,voted_at,added_at_door')
    expect(text).toContain('President')
  })

  it('still lists who voted after the roll has been purged', async () => {
    // an inner join would return a header and no rows: "nobody voted"
    await closeElection(f)
    await env.DB.prepare('DELETE FROM check_in').run()
    await env.DB.prepare('DELETE FROM voter_roll').run()
    const { text, rows } = await csvOf(await forElection('attendance.csv'))
    expect(rows).toHaveLength(3)
    expect(text).toContain('2400001')
    expect(text).not.toContain('Lovelace')
  })

  it('carries added_at_door in the attendance export, so the total has provenance', async () => {
    await addDoorVoter(f)
    const cookie = await voterSignIn(f.batchId, NEW_MEMBER.usu_id, NEW_MEMBER.last_name)
    await submitBallot(f.batchId, f.electionId, cookie, [f.candidateIds.a, f.candidateIds.b])
    await closeElection(f)
    const { rows } = await csvOf(await forElection('attendance.csv'))
    expect(rows.find((l) => l.includes(NEW_MEMBER.usu_id))).toMatch(/"1"$/)
    // a member from the export is marked 0
    expect(rows.find((l) => l.includes('2400001'))).toMatch(/"0"$/)
  })

  it('exports everyone checked in, whether or not they voted, and guests only as their own file', async () => {
    // setUp's three all voted, so check in someone who has not
    await checkIn(f.batchId, f.doorCookie, '2400006')
    await addGuest(f)
    const res = await get('/check-ins.csv')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-disposition')).toContain(`check-ins-${f.batchId}.csv`)
    const checkIns = await csvOf(res)
    expect(checkIns.header).toBe('usu_id,first_name,last_name,eligible,added_at_door,checked_in_at')
    expect(checkIns.rows.map((r) => r.split(',')[0]).sort()).toEqual(['"2400001"', '"2400002"', '"2400004"', '"2400006"'])

    const guests = await csvOf(await get('/guests.csv'))
    expect(guests.header).toBe('name,note,checked_in_at')
    expect(guests.text).toContain('Jo Visitor')
    expect(checkIns.text).not.toContain('Jo Visitor')
    expect(await (await get('/attendance.csv')).text()).not.toContain('Jo Visitor')
  })
})
