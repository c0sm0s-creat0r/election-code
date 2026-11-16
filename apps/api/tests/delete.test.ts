/**
 * The two delete routes and what each refuses. An officer can remove a
 * mistake, never a vote. The operator can remove a society, with a
 * confirmation and an audit row.
 */
import { describe, it, expect } from 'vitest'
import { env } from 'cloudflare:test'
import {
  MEMBERS, SUPER_KEY, addCandidate, api, batchBody, cast, checkIn, closeElection, countOf, createBatch,
  createElection, importRoll, openElection, postBatch, resetDatabase, setUp, signIn, submitBallot,
  tokenOf, voterSignIn,
} from './helpers.js'

const deleteElection = (batchId: string, electionId: string, cookie: string) =>
  api('DELETE', `/batches/${batchId}/elections/${electionId}`, cookie)

const deleteBatch = (batchId: string, body: unknown, key?: string) =>
  api('DELETE', `/batches/${batchId}`, '', body, key === undefined ? {} : { 'x-super-admin-key': key })

const auditRow = (action: string) =>
  env.DB.prepare('SELECT batch_id, detail FROM audit_log WHERE action = ?').bind(action)
    .first<{ batch_id: string | null; detail: string | null }>()

describe('deleting an election', () => {
  it('removes a draft and its candidates, recording a status and nothing else', async () => {
    const { batchId, officerCookie } = await setUp([])
    const draft = await createElection(batchId, officerCookie, 'Secretary', 1)
    await addCandidate(batchId, officerCookie, draft, 'Alex')

    expect((await deleteElection(batchId, draft, officerCookie)).status).toBe(204)
    expect(await countOf('election', 'id = ?', draft)).toBe(0)
    expect(await countOf('candidate', 'election_id = ?', draft)).toBe(0)
    // No election name or id: the audit row outlives what it describes.
    expect((await auditRow('election.delete'))!.detail).toBe(JSON.stringify({ kind: 'election_delete', status: 'draft' }))
  })

  it('removes an open election nobody has voted in: the mis-opened one', async () => {
    const { batchId, officerCookie, electionId } = await setUp([])
    expect((await deleteElection(batchId, electionId, officerCookie)).status).toBe(204)
    expect(await countOf('election', 'id = ?', electionId)).toBe(0)
  })

  it('REFUSES ONE THAT HAS A BALLOT IN IT, even a voided one, and leaves it standing', async () => {
    const f = await setUp(['2400001'])
    const token = await tokenOf(await cast(f, '2400001', 'a'))
    const refused = async () => {
      const res = await deleteElection(f.batchId, f.electionId, f.officerCookie)
      expect(res.status).toBe(409)
      expect(await res.json()).toMatchObject({ code: 'has_ballots' })
      expect(await countOf('election', 'id = ?', f.electionId)).toBe(1)
      expect(await countOf('ballot', 'election_id = ?', f.electionId)).toBe(1)
    }
    await refused()
    // a voided ballot stays in the table, so the seal covers it
    await api('POST', `/receipts/${token}/void`)
    await refused()
  })

  it('removes a closed election with an empty box, seal and result included', async () => {
    // Neither table cascades, so the route deletes them explicitly.
    const f = await setUp([])
    await closeElection(f)
    expect(await countOf('election_seal', 'election_id = ?', f.electionId)).toBe(1)

    expect((await deleteElection(f.batchId, f.electionId, f.officerCookie)).status).toBe(204)
    expect(await countOf('election_seal')).toBe(0)
    expect(await countOf('election_result')).toBe(0)
  })

  it('cannot reach an election belonging to another society', async () => {
    const { batchId, officerCookie } = await setUp([])
    const otherId = await createBatch('other')
    const theirs = await createElection(otherId, await signIn(otherId, 'officer', 'officer-password-1'), 'Theirs', 1)

    expect((await deleteElection(batchId, theirs, officerCookie)).status).toBe(404)
    expect(await countOf('election', 'id = ?', theirs)).toBe(1)
  })
})

describe('deleting a society', () => {
  const doomed = async () => {
    await resetDatabase()
    return createBatch('doomed')
  }

  it('refuses with no key or a wrong one, recording the wrong one against no batch', async () => {
    const batchId = await doomed()
    expect((await deleteBatch(batchId, { confirm_slug: 'doomed' })).status).toBe(401)
    expect((await deleteBatch(batchId, { confirm_slug: 'doomed' }, 'not-the-key')).status).toBe(401)
    expect(await countOf('batch', 'id = ?', batchId)).toBe(1)
    // The supplied key does not appear, even in part.
    expect(await auditRow('batch.delete.denied')).toEqual({ batch_id: null, detail: null })
  })

  it('REFUSES WITHOUT THE SLUG TYPED BACK, because the id is a UUID nobody checks', async () => {
    const batchId = await doomed()
    for (const body of [{ confirm_slug: 'something-else' }, {}]) {
      const res = await deleteBatch(batchId, body, SUPER_KEY)
      expect(res.status).toBe(409)
      expect(await res.json()).toMatchObject({ code: 'confirm_required' })
    }
    expect(await countOf('batch', 'id = ?', batchId)).toBe(1)
    expect((await deleteBatch('no-such-id', { confirm_slug: 'doomed' }, SUPER_KEY)).status).toBe(404)
  })

  it('DESTROYS EVERY TABLE THE SOCIETY OWNS, sealed ballots included, but KEEPS THE AUDIT TRAIL', async () => {
    // A roll, check-ins, and a closed election with a ballot, a seal and a result.
    const f = await setUp(['2400001', '2400002'])
    await cast(f, '2400001', 'a')
    await closeElection(f)

    expect((await deleteBatch(f.batchId, { confirm_slug: 's' }, SUPER_KEY)).status).toBe(204)

    for (const table of ['batch', 'voter_roll', 'check_in', 'guest', 'election', 'candidate',
      'ballot', 'vote_receipt', 'election_seal', 'election_result']) {
      expect(await countOf(table), table).toBe(0)
    }
    // audit_log has no foreign key to batch, so it does not cascade. The
    // deletion is recorded as counts.
    expect(await auditRow('batch.delete')).toEqual({
      batch_id: f.batchId, detail: JSON.stringify({ kind: 'batch_delete', elections: 1, ballots: 1, voters: 6 }),
    })
    expect(await countOf('audit_log', `action = 'batch.create'`)).toBe(1)
  })

  it('LEAVES EVERY OTHER SOCIETY ALONE', async () => {
    // a delete must stay inside its batch
    const batchId = await doomed()
    const survivorId = await createBatch('survivor')
    const officer = await signIn(survivorId, 'officer', 'officer-password-1')
    await importRoll(survivorId, officer)
    const theirElection = await createElection(survivorId, officer, 'Theirs', 1)
    const alex = await addCandidate(survivorId, officer, theirElection, 'Alex')
    await addCandidate(survivorId, officer, theirElection, 'Bo')
    await openElection(survivorId, officer, theirElection)
    await checkIn(survivorId, await signIn(survivorId, 'door', 'door-password-1'), '2400001')
    await submitBallot(survivorId, theirElection, await voterSignIn(survivorId, '2400001', MEMBERS['2400001']), [alex])

    await deleteBatch(batchId, { confirm_slug: 'doomed' }, SUPER_KEY)

    expect(await countOf('batch')).toBe(1)
    // Six rows: the fixture's whole export, eligible members and not.
    expect(await countOf('voter_roll', 'batch_id = ?', survivorId)).toBe(6)
    expect(await countOf('check_in', 'batch_id = ?', survivorId)).toBe(1)
    expect(await countOf('election', 'batch_id = ?', survivorId)).toBe(1)
    expect(await countOf('ballot', 'election_id = ?', theirElection)).toBe(1)
  })

  it('takes the society off the public list and frees the slug', async () => {
    const batchId = await doomed()
    expect(await (await api('GET', '/batches')).json()).toHaveLength(1)

    await deleteBatch(batchId, { confirm_slug: 'doomed' }, SUPER_KEY)

    expect(await (await api('GET', '/batches')).json()).toHaveLength(0)
    expect((await api('GET', '/batches/by-slug/doomed')).status).toBe(404)
    expect((await postBatch(batchBody('doomed', 2))).status).toBe(201)
  })
})
