/**
 * Privacy checks over a database that has been through a whole election.
 * These catch failures that span handlers, such as one handler's audit row
 * surviving another's purge.
 */
import { describe, it, expect, beforeAll } from 'vitest'
import { env } from 'cloudflare:test'
import {
  ALL_TABLES, NEW_MEMBER, addCandidate, addDoorVoter, addGuest, api, checkIn, closeElection, countOf,
  createElection, getResult, openElection, postBatch, setUpBatch, staffSession, submitBallot, tokenOf,
  uploadRoll, voterSession, voterSignIn,
} from './helpers.js'

/** Any 7-digit run: the shape of a USU Net Id. */
const USU_ID_SHAPE = /\d{7}/
/** Any UUID prefix: the shape of a ballot id, a candidate id or a receipt token. */
const UUID_SHAPE = /[0-9a-f]{8}-[0-9a-f]{4}/

let batchId = ''
/** Rows the purge was about to delete. */
let purgeable = 0

/**
 * Provision, import, check in, open, vote, void, recast, close, count, purge.
 * Run once: the pool rolls each test's writes back to this state. Every
 * audited action the inventory below lists must run here.
 */
beforeAll(async () => {
  const f = await setUpBatch()
  batchId = f.batchId
  const { officerCookie, doorCookie } = f
  // a denied super-admin attempt, which audits with a NULL batch
  await postBatch({}, 'wrong')
  // a failed staff sign-in
  await staffSession(batchId, 'officer', 'wrong-password-here')

  await uploadRoll(batchId, officerCookie)
  const electionId = await createElection(batchId, officerCookie, 'President', 2)
  const candidates: string[] = []
  for (const name of ['Alex', 'Bo', 'Cass']) candidates.push(await addCandidate(batchId, officerCookie, electionId, name))
  const [alex, bo, cass] = candidates as [string, string, string]
  // a rename while still in draft
  await api('PATCH', `/batches/${batchId}/elections/${electionId}/candidates/${cass}`, officerCookie, { name: 'Cassandra' })
  await openElection(batchId, officerCookie, electionId)

  // two voters through the door, one of them un-checked-in and back again
  await checkIn(batchId, doorCookie, '2400001')
  await checkIn(batchId, doorCookie, '2400002')
  await api('DELETE', `/batches/${batchId}/check-in/2400002`, doorCookie)
  await checkIn(batchId, doorCookie, '2400002')

  const ada = await voterSignIn(batchId, '2400001', 'Lovelace')
  const alan = await voterSignIn(batchId, '2400002', 'Turing')
  // a wrong surname, which writes no audit row (see routes/voter.ts)
  await voterSession(batchId, '2400001', 'Wrong')
  // a refusal for a real but ineligible member, which does audit
  await voterSession(batchId, '2400003', 'Hopper')

  const first = await tokenOf(await submitBallot(batchId, electionId, ada, [alex, bo]))
  await submitBallot(batchId, electionId, alan, [bo, alex])
  // void and recast
  await api('POST', `/receipts/${first}/void`)
  await submitBallot(batchId, electionId, ada, [bo, alex])

  // A guest and a door-added member, before the purge so the inventory sees
  // them. The member is removed again to run both actions.
  await addGuest(f, { name: 'Jo Verydistinctiveguest', note: 'observer' })
  await addDoorVoter(f, { ...NEW_MEMBER, last_name: 'Verydistinctivejoiner' })
  await api('DELETE', `/batches/${batchId}/voters/${NEW_MEMBER.usu_id}`, doorCookie)

  const officer = { batchId, officerCookie, electionId }
  await closeElection(officer)
  await getResult(officer)
  await api('PATCH', `/batches/${batchId}/branding`, officerCookie,
    { title: 'AGM', org_name: 'Soc', accent_color: '#123456', logo_url: '' })
  purgeable = await countOf('voter_roll') + await countOf('check_in') + await countOf('guest')
  await api('DELETE', `/batches/${batchId}/roll`, officerCookie)
})

describe('privacy and secret-ballot invariants after a whole election', () => {
  it('audits every action, with counts only: no USU id, no UUID, no name', async () => {
    const { results } = await env.DB.prepare('SELECT batch_id, action, detail FROM audit_log ORDER BY id')
      .all<{ batch_id: string | null; action: string; detail: string | null }>()

    // so the checks below are not passing on an empty table
    expect([...new Set(results.map((r) => r.action))].sort()).toEqual([
      'ballot.cast', 'ballot.void', 'batch.create', 'batch.create.denied', 'branding.update',
      'candidate.add', 'candidate.update', 'check_in.add', 'check_in.remove',
      'election.close', 'election.count', 'election.create', 'election.open',
      'guest.add', 'roll.import', 'roll.purge',
      'session.door.ok', 'session.officer.fail', 'session.officer.ok', 'session.voter.fail', 'session.voter.ok',
      'voter.add_at_door', 'voter.remove_at_door',
    ])

    for (const r of results) {
      const text = `${r.action} ${r.detail ?? ''}`
      expect(text, `audit row ${r.action} leaked an identifier`).not.toMatch(USU_ID_SHAPE)
      expect(text, `audit row ${r.action} leaked a UUID`).not.toMatch(UUID_SHAPE)
      // attributed to the owning batch, a public receipt void included
      expect(r.batch_id, r.action).toBe(r.action === 'batch.create.denied' ? null : batchId)
    }
    // audit_log is never purged, so a guest's or a door-added member's name must not reach it
    expect(JSON.stringify(results)).not.toMatch(/Verydistinctive/)

    // The only details: the allow-list in db/audit.ts. Everything else is NULL.
    const details = Object.fromEntries(
      results.filter((r) => r.detail !== null).map((r) => [r.action, JSON.parse(r.detail!) as unknown]))
    expect(details).toEqual({
      'roll.import': { kind: 'roll_import', total: 6, eligible: 4, excluded: 2, skipped: 0 },
      'election.open': { kind: 'election_open', seats: 2, candidates: 3 },
      'election.close': { kind: 'election_close', ballotCount: 3 },
      'election.count': { kind: 'count', rounds: expect.any(Number), winners: 2 },
      'roll.purge': { kind: 'roll_purge', rowsDeleted: purgeable },
    })
    expect(purgeable).toBe(6 + 2 + 1)
  })

  it('stores no email address anywhere in the database', async () => {
    // the export has one per member
    for (const t of ALL_TABLES) {
      const rows = await env.DB.prepare(`SELECT * FROM ${t}`).all()
      expect(JSON.stringify(rows.results), `${t} carried an email address`).not.toMatch(/@example\.com/)
    }
  })

  it('leaves one live ballot per voter who voted, and no ballot-to-voter link at all', async () => {
    expect(await countOf('ballot')).toBe(3)
    expect(await countOf('ballot', 'voided = 0')).toBe(await countOf('vote_receipt'))
    // live_receipt_hash is cleared at close. The purge must not restore it.
    expect(await countOf('vote_receipt', 'live_receipt_hash IS NOT NULL')).toBe(0)
  })

  it('keeps the checkable record while holding no member names', async () => {
    for (const table of ['voter_roll', 'check_in', 'guest']) expect(await countOf(table), table).toBe(0)
    for (const table of ['ballot', 'election_seal', 'election_result', 'vote_receipt']) {
      expect(await countOf(table), table).toBeGreaterThan(0)
    }
  })
})
