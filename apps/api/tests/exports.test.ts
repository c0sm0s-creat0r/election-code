import { describe, it, expect, beforeEach } from 'vitest'
import { SELF, env } from 'cloudflare:test'
import { setUp, submitBallot, voterSignIn, sha256Hex, JSON_HEADERS, type Fixture } from './helpers.js'

let f: Fixture

beforeEach(async () => {
  f = await setUp()
  const { a, b } = f.candidateIds
  await submitBallot(f.batchId, f.electionId, f.voterCookies['2400001']!, [a, b])
  await submitBallot(f.batchId, f.electionId, f.voterCookies['2400002']!, [a, b])
  await submitBallot(f.batchId, f.electionId, f.voterCookies['2400004']!, [b, a])
})

const close = () =>
  SELF.fetch(`https://example.com/api/batches/${f.batchId}/elections/${f.electionId}/close`, {
    method: 'POST', headers: { cookie: f.officerCookie },
  })

const getResult = () =>
  SELF.fetch(`https://example.com/api/batches/${f.batchId}/elections/${f.electionId}/result`, {
    headers: { cookie: f.officerCookie },
  })

const closeAndCount = async () => { await close(); await getResult() }

const get = (path: string, cookie = f.officerCookie) =>
  SELF.fetch(`https://example.com/api/batches/${f.batchId}${path}`, { headers: { cookie } })

describe('exports', () => {
  it('requires an officer session', async () => {
    expect((await get('/attendance.csv', '')).status).toBe(401)
    expect((await get(`/elections/${f.electionId}/ballots.csv`, '')).status).toBe(401)
  })

  it('refuses a door session', async () => {
    expect((await get('/attendance.csv', f.doorCookie)).status).toBe(403)
  })

  it('exports attendance as who voted, never what', async () => {
    await close()
    const text = await (await get(`/elections/${f.electionId}/attendance.csv`)).text()
    expect(text.split('\n')[0]).toBe('usu_id,first_name,last_name,voted_at,recast_count,added_at_door')
    expect(text).not.toMatch(/preferences|ballot_id/)
    expect(text).toContain('2400001')
    expect(text).toContain('Lovelace')
  })

  it('lists only members who actually voted', async () => {
    await close()
    const text = await (await get(`/elections/${f.electionId}/attendance.csv`)).text()
    const rows = text.trim().split('\n').slice(1)
    expect(rows).toHaveLength(3)
    // checked in but never voted, so absent from the mark-off
    expect(text).not.toContain('2400006')
  })

  it('sets a Content-Disposition filename', async () => {
    await close()
    const res = await get(`/elections/${f.electionId}/attendance.csv`)
    expect(res.headers.get('content-disposition')).toMatch(/attachment; filename=/)
    expect(res.headers.get('content-type')).toMatch(/text\/csv/)
  })

  it('exports ballots anonymously, with no voter reference', async () => {
    await close()
    const text = await (await get(`/elections/${f.electionId}/ballots.csv`)).text()
    expect(text.split('\n')[0]).toBe('ballot_id,preferences,voided')
    for (const usuId of Object.keys(f.voterCookies)) expect(text).not.toContain(usuId)
  })

  it('exports ballots ORDERED BY ID, so the digest can be recomputed', async () => {
    await close()
    const text = await (await get(`/elections/${f.electionId}/ballots.csv`)).text()
    const ids = text.trim().split('\n').slice(1).map((l) => l.split(',')[0]!.replace(/"/g, ''))
    expect(ids).toEqual([...ids].sort())
  })

  it('LETS A THIRD PARTY RECOMPUTE THE SEAL from the export alone', async () => {
    await close()
    const text = await (await get(`/elections/${f.electionId}/ballots.csv`)).text()
    // parse the export the way an outsider would, then rebuild the canonical
    // serialisation spec §2 defines
    const rows = text.trim().split('\n').slice(1).map((line) => {
      const [id, prefs, voided] = line.split('","').map((field) => field.replace(/^"|"$/g, ''))
      return {
        id: id!,
        preferences: JSON.stringify(prefs!.split('|').filter(Boolean)),
        voided: Number(voided!),
      }
    })
    const canonical = rows.map((r) => `${r.id}|${r.preferences}|${r.voided}`).join('\n')
    const seal = await env.DB.prepare('SELECT ballots_sha256 FROM election_seal').first<{ ballots_sha256: string }>()
    expect(await sha256Hex(canonical)).toBe(seal!.ballots_sha256)
  })

  it('includes a voided ballot in the export, so the digest still matches', async () => {
    const row = await env.DB.prepare('SELECT live_receipt_hash FROM vote_receipt WHERE usu_id = ?')
      .bind('2400004').first<{ live_receipt_hash: string }>()
    await env.DB.prepare('UPDATE ballot SET voided = 1 WHERE receipt_hash = ?')
      .bind(row!.live_receipt_hash).run()
    await close()
    const text = await (await get(`/elections/${f.electionId}/ballots.csv`)).text()
    expect(text.trim().split('\n').slice(1)).toHaveLength(3)
    expect(text).toMatch(/","1"$/m)
  })

  it('refuses a ballot export before the election is closed', async () => {
    expect((await get(`/elections/${f.electionId}/ballots.csv`)).status).toBe(409)
  })

  it('exports the candidate list beside the ballots, so a recount has both halves', async () => {
    await close()
    const text = await (await get(`/elections/${f.electionId}/candidates.csv`)).text()
    expect(text.split('\n')[0]).toBe('candidate_id,name')
    expect(text).toContain('Alex')
  })

  it('exports the whole batch attendance across elections', async () => {
    await close()
    const text = await (await get('/attendance.csv')).text()
    expect(text.split('\n')[0])
      .toBe('election_id,election_name,usu_id,first_name,last_name,voted_at,added_at_door')
    expect(text).toContain('President')
  })

  it('exports the sealed result with its tie-breaks', async () => {
    await closeAndCount()
    const body = await (await get(`/elections/${f.electionId}/result.json`)).json() as Record<string, unknown>
    expect(Object.keys(body).sort()).toEqual([
      'ballot_count', 'ballots_sha256', 'closed_at', 'computed_at',
      'election', 'overridden', 'quota', 'rounds', 'tie_breaks', 'winners',
    ])
  })

  it('refuses a result export before a count exists', async () => {
    await close()
    expect((await get(`/elections/${f.electionId}/result.json`)).status).toBe(409)
  })

  it('still lists who voted after the roll has been purged', async () => {
    // the export is meant to be taken before the purge, but an inner join would
    // return a header and no rows, which reads as "nobody voted"
    await closeAndCount()
    await env.DB.prepare('DELETE FROM check_in').run()
    await env.DB.prepare('DELETE FROM voter_roll').run()
    const text = await (await get(`/elections/${f.electionId}/attendance.csv`)).text()
    expect(text.trim().split('\n').slice(1)).toHaveLength(3)
    expect(text).toContain('2400001')
    expect(text).not.toContain('Lovelace')
  })

  it('404s an election in another batch', async () => {
    expect((await get(`/elections/${crypto.randomUUID()}/ballots.csv`)).status).toBe(404)
  })

  it('carries added_at_door in the attendance export, so the total has provenance', async () => {
    await SELF.fetch(`https://example.com/api/batches/${f.batchId}/voters`, {
      method: 'POST', headers: { ...JSON_HEADERS, cookie: f.doorCookie },
      body: JSON.stringify({ usu_id: '2400777', first_name: 'Nina', last_name: 'Newjoiner' }),
    })
    const cookie = await voterSignIn(f.batchId, '2400777', 'Newjoiner')
    await submitBallot(f.batchId, f.electionId, cookie, [f.candidateIds.a, f.candidateIds.b])
    await close()
    const text = await (await get(`/elections/${f.electionId}/attendance.csv`)).text()
    expect(text.split('\n')[0]).toBe('usu_id,first_name,last_name,voted_at,recast_count,added_at_door')
    const nina = text.split('\n').find((l) => l.includes('2400777'))
    expect(nina).toMatch(/"1"$/)
    // and a member from the export is marked 0, so the column distinguishes
    const ada = text.split('\n').find((l) => l.includes('2400001'))
    expect(ada).toMatch(/"0"$/)
  })

  it('carries added_at_door in the batch attendance export too', async () => {
    await close()
    const text = await (await get('/attendance.csv')).text()
    expect(text.split('\n')[0])
      .toBe('election_id,election_name,usu_id,first_name,last_name,voted_at,added_at_door')
  })

  it('exports guests as their own file, not as attendance rows', async () => {
    await SELF.fetch(`https://example.com/api/batches/${f.batchId}/guests`, {
      method: 'POST', headers: { ...JSON_HEADERS, cookie: f.doorCookie },
      body: JSON.stringify({ name: 'Jo Visitor', note: 'observer' }),
    })
    const text = await (await get('/guests.csv')).text()
    expect(text.split('\n')[0]).toBe('name,note,checked_in_at')
    expect(text).toContain('Jo Visitor')
    const attendance = await (await get('/attendance.csv')).text()
    expect(attendance).not.toContain('Jo Visitor')
  })

  it('requires an officer session for the guest export', async () => {
    expect((await get('/guests.csv', f.doorCookie)).status).toBe(403)
  })
})
