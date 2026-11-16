/**
 * The two delete routes and what each refuses. An officer can remove a
 * mistake, never a vote. The operator can remove a society, with a
 * confirmation and an audit row.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { SELF, env } from 'cloudflare:test'
import {
  JSON_HEADERS, MEMBERS, SUPER_KEY, addCandidate, checkIn, createBatch, createElection,
  importRoll, openElection, resetDatabase, setUp, signIn, submitBallot, voterSignIn,
} from './helpers.js'

const at = (path: string) => `https://example.com${path}`

const deleteElection = (batchId: string, electionId: string, cookie: string) =>
  SELF.fetch(at(`/api/batches/${batchId}/elections/${electionId}`), {
    method: 'DELETE', headers: { cookie },
  })

const deleteBatch = (batchId: string, body: unknown, key?: string) =>
  SELF.fetch(at(`/api/batches/${batchId}`), {
    method: 'DELETE',
    headers: { ...JSON_HEADERS, ...(key === undefined ? {} : { 'x-super-admin-key': key }) },
    body: JSON.stringify(body),
  })

const countIn = async (table: string, where: string, ...binds: string[]): Promise<number> => {
  const row = await env.DB.prepare(`SELECT count(*) AS n FROM ${table} WHERE ${where}`)
    .bind(...binds)
    .first<{ n: number }>()
  return row?.n ?? 0
}

const auditActions = async (): Promise<{ action: string; batch_id: string | null; detail: string | null }[]> => {
  const { results } = await env.DB
    .prepare(`SELECT action, batch_id, detail FROM audit_log ORDER BY id`)
    .all<{ action: string; batch_id: string | null; detail: string | null }>()
  return results
}

describe('deleting an election', () => {
  it('removes a draft, which is the case that is always a mistake', async () => {
    const { batchId, officerCookie } = await setUp([])
    const draft = await createElection(batchId, officerCookie, 'Secretary', 1)

    const res = await deleteElection(batchId, draft, officerCookie)
    expect(res.status).toBe(204)
    expect(await countIn('election', 'id = ?', draft)).toBe(0)
  })

  it('takes the candidates with it', async () => {
    const { batchId, officerCookie } = await setUp([])
    const draft = await createElection(batchId, officerCookie, 'Secretary', 1)
    await addCandidate(batchId, officerCookie, draft, 'Alex')

    await deleteElection(batchId, draft, officerCookie)
    expect(await countIn('candidate', 'election_id = ?', draft)).toBe(0)
  })

  it('removes an open election nobody has voted in — the mis-opened one', async () => {
    const { batchId, officerCookie, electionId } = await setUp([])

    const res = await deleteElection(batchId, electionId, officerCookie)
    expect(res.status).toBe(204)
    expect(await countIn('election', 'id = ?', electionId)).toBe(0)
  })

  it('REFUSES ONE THAT HAS A BALLOT IN IT, and leaves it standing', async () => {
    const { batchId, officerCookie, electionId, candidateIds, voterCookies } = await setUp(['2400001'])
    await submitBallot(batchId, electionId, voterCookies['2400001']!, [candidateIds.a])

    const res = await deleteElection(batchId, electionId, officerCookie)
    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({ code: 'has_ballots' })
    expect(await countIn('election', 'id = ?', electionId)).toBe(1)
    expect(await countIn('ballot', 'election_id = ?', electionId)).toBe(1)
  })

  it('refuses one whose only ballot was voided, because the row is still there', async () => {
    // a voided ballot stays in the table, so the seal covers it
    const { batchId, officerCookie, electionId, candidateIds, voterCookies } = await setUp(['2400001'])
    const cast = await submitBallot(batchId, electionId, voterCookies['2400001']!, [candidateIds.a])
    const { receipt_token } = (await cast.json()) as { receipt_token: string }
    await SELF.fetch(at(`/api/receipts/${receipt_token}/void`), { method: 'POST' })

    const res = await deleteElection(batchId, electionId, officerCookie)
    expect(res.status).toBe(409)
    expect(await countIn('election', 'id = ?', electionId)).toBe(1)
  })

  it('removes a closed election with an empty box, seal and result included', async () => {
    // Neither table cascades, so the route deletes them explicitly.
    const { batchId, officerCookie, electionId } = await setUp([])
    await SELF.fetch(at(`/api/batches/${batchId}/elections/${electionId}/close`), {
      method: 'POST', headers: { cookie: officerCookie },
    })
    expect(await countIn('election_seal', 'election_id = ?', electionId)).toBe(1)

    const res = await deleteElection(batchId, electionId, officerCookie)
    expect(res.status).toBe(204)
    expect(await countIn('election_seal', 'election_id = ?', electionId)).toBe(0)
    expect(await countIn('election_result', 'election_id = ?', electionId)).toBe(0)
  })

  it('cannot reach an election belonging to another society', async () => {
    const { batchId, officerCookie } = await setUp([])
    const otherId = await createBatch('other')
    const otherOfficer = await signIn(otherId, 'officer', 'officer-password-1')
    const theirs = await createElection(otherId, otherOfficer, 'Theirs', 1)

    const res = await deleteElection(batchId, theirs, officerCookie)
    expect(res.status).toBe(404)
    expect(await countIn('election', 'id = ?', theirs)).toBe(1)
  })

  it('refuses a door session, which is the privilege boundary', async () => {
    const { batchId, doorCookie, electionId } = await setUp([])
    const res = await deleteElection(batchId, electionId, doorCookie)
    expect(res.status).toBe(403)
    expect(await countIn('election', 'id = ?', electionId)).toBe(1)
  })

  it('refuses with no session at all', async () => {
    const { batchId, electionId } = await setUp([])
    const res = await SELF.fetch(at(`/api/batches/${batchId}/elections/${electionId}`), { method: 'DELETE' })
    expect(res.status).toBe(401)
    expect(await countIn('election', 'id = ?', electionId)).toBe(1)
  })

  it('records the deletion as a status and nothing else', async () => {
    const { batchId, officerCookie } = await setUp([])
    const draft = await createElection(batchId, officerCookie, 'Secretary', 1)
    await deleteElection(batchId, draft, officerCookie)

    const entry = (await auditActions()).find((row) => row.action === 'election.delete')
    expect(entry).toBeDefined()
    expect(JSON.parse(entry!.detail!)).toEqual({ kind: 'election_delete', status: 'draft' })
    // No election name or id: the audit row outlives what it describes.
    expect(entry!.detail).not.toContain('Secretary')
    expect(entry!.detail).not.toContain(draft)
  })
})

describe('deleting a society', () => {
  let batchId: string
  let slug: string

  beforeEach(async () => {
    await resetDatabase()
    slug = 'doomed'
    batchId = await createBatch(slug)
  })

  it('refuses with no key, and the society survives', async () => {
    const res = await deleteBatch(batchId, { confirm_slug: slug })
    expect(res.status).toBe(401)
    expect(await countIn('batch', 'id = ?', batchId)).toBe(1)
  })

  it('refuses a wrong key, and records the attempt against no batch', async () => {
    const res = await deleteBatch(batchId, { confirm_slug: slug }, 'not-the-key')
    expect(res.status).toBe(401)
    expect(await countIn('batch', 'id = ?', batchId)).toBe(1)

    const denied = (await auditActions()).find((row) => row.action === 'batch.delete.denied')
    expect(denied).toBeDefined()
    expect(denied!.batch_id).toBeNull()
    // The supplied key does not appear, even in part.
    expect(denied!.detail).toBeNull()
  })

  it('REFUSES WITHOUT THE SLUG TYPED BACK, because the id is a UUID nobody checks', async () => {
    const res = await deleteBatch(batchId, { confirm_slug: 'something-else' }, SUPER_KEY)
    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({ code: 'confirm_required' })
    expect(await countIn('batch', 'id = ?', batchId)).toBe(1)
  })

  it('refuses an empty body for the same reason', async () => {
    const res = await deleteBatch(batchId, {}, SUPER_KEY)
    expect(res.status).toBe(409)
    expect(await countIn('batch', 'id = ?', batchId)).toBe(1)
  })

  it('404s on a society that is not there', async () => {
    const res = await deleteBatch('no-such-id', { confirm_slug: slug }, SUPER_KEY)
    expect(res.status).toBe(404)
  })

  it('DESTROYS EVERY TABLE THE SOCIETY OWNS, sealed ballots included', async () => {
    // A roll, check-ins, and a closed election with ballots and a seal.
    const fixture = await setUp(['2400001', '2400002'])
    await submitBallot(fixture.batchId, fixture.electionId, fixture.voterCookies['2400001']!, [fixture.candidateIds.a])
    await SELF.fetch(at(`/api/batches/${fixture.batchId}/elections/${fixture.electionId}/close`), {
      method: 'POST', headers: { cookie: fixture.officerCookie },
    })
    const theSlug = 's'

    const res = await deleteBatch(fixture.batchId, { confirm_slug: theSlug }, SUPER_KEY)
    expect(res.status).toBe(204)

    expect(await countIn('batch', 'id = ?', fixture.batchId)).toBe(0)
    expect(await countIn('voter_roll', 'batch_id = ?', fixture.batchId)).toBe(0)
    expect(await countIn('check_in', 'batch_id = ?', fixture.batchId)).toBe(0)
    expect(await countIn('guest', 'batch_id = ?', fixture.batchId)).toBe(0)
    expect(await countIn('election', 'batch_id = ?', fixture.batchId)).toBe(0)
    expect(await countIn('candidate', 'election_id = ?', fixture.electionId)).toBe(0)
    expect(await countIn('ballot', 'election_id = ?', fixture.electionId)).toBe(0)
    expect(await countIn('vote_receipt', 'election_id = ?', fixture.electionId)).toBe(0)
    expect(await countIn('election_seal', 'election_id = ?', fixture.electionId)).toBe(0)
    expect(await countIn('election_result', 'election_id = ?', fixture.electionId)).toBe(0)
  })

  it('LEAVES EVERY OTHER SOCIETY ALONE', async () => {
    // a delete must stay inside its batch
    const survivorId = await createBatch('survivor')
    const survivorOfficer = await signIn(survivorId, 'officer', 'officer-password-1')
    const survivorDoor = await signIn(survivorId, 'door', 'door-password-1')
    await importRoll(survivorId, survivorOfficer)
    const theirElection = await createElection(survivorId, survivorOfficer, 'Theirs', 1)
    await addCandidate(survivorId, survivorOfficer, theirElection, 'Alex')
    await addCandidate(survivorId, survivorOfficer, theirElection, 'Bo')
    await openElection(survivorId, survivorOfficer, theirElection)
    await checkIn(survivorId, survivorDoor, '2400001')
    const voter = await voterSignIn(survivorId, '2400001', MEMBERS['2400001'])
    const listed = await SELF.fetch(at(`/api/batches/${survivorId}/elections`))
    const theirCandidates = ((await listed.json()) as { candidates: { id: string }[] }[])[0]!.candidates
    await submitBallot(survivorId, theirElection, voter, [theirCandidates[0]!.id])

    await deleteBatch(batchId, { confirm_slug: slug }, SUPER_KEY)

    expect(await countIn('batch', 'id = ?', survivorId)).toBe(1)
    // Six rows: the fixture's whole export, eligible members and not.
    expect(await countIn('voter_roll', 'batch_id = ?', survivorId)).toBe(6)
    expect(await countIn('check_in', 'batch_id = ?', survivorId)).toBe(1)
    expect(await countIn('election', 'batch_id = ?', survivorId)).toBe(1)
    expect(await countIn('ballot', 'election_id = ?', theirElection)).toBe(1)
  })

  it('KEEPS THE AUDIT TRAIL, and records the deletion as counts', async () => {
    // audit_log has no foreign key to batch, so it does not cascade.
    const fixture = await setUp(['2400001'])
    await submitBallot(fixture.batchId, fixture.electionId, fixture.voterCookies['2400001']!, [fixture.candidateIds.a])

    await deleteBatch(fixture.batchId, { confirm_slug: 's' }, SUPER_KEY)

    const rows = await auditActions()
    expect(rows.length).toBeGreaterThan(1)
    const entry = rows.find((row) => row.action === 'batch.delete')
    expect(entry).toBeDefined()
    expect(entry!.batch_id).toBe(fixture.batchId)
    expect(JSON.parse(entry!.detail!)).toEqual({
      kind: 'batch_delete', elections: 1, ballots: 1, voters: 6,
    })
    // Rows written before the deletion are still there.
    expect(rows.filter((row) => row.action === 'batch.create')).toHaveLength(1)
  })

  it('takes the society off the public list', async () => {
    const before = (await (await SELF.fetch(at('/api/batches'))).json()) as unknown[]
    expect(before).toHaveLength(1)

    await deleteBatch(batchId, { confirm_slug: slug }, SUPER_KEY)

    const after = (await (await SELF.fetch(at('/api/batches'))).json()) as unknown[]
    expect(after).toHaveLength(0)
    expect((await SELF.fetch(at(`/api/batches/by-slug/${slug}`))).status).toBe(404)
  })

  it('frees the slug, so the name can be registered again', async () => {
    await deleteBatch(batchId, { confirm_slug: slug }, SUPER_KEY)
    const res = await SELF.fetch(at('/api/batches'), {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({
        name: 'Second Try', slug,
        officer_password: 'officer-password-2', door_password: 'door-password-2',
        branding: { title: 't', org_name: 'o', accent_color: '#000000', logo_url: '' },
      }),
    })
    expect(res.status).toBe(201)
  })
})
