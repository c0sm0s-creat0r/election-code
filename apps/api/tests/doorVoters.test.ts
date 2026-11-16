import { describe, it, expect, beforeEach } from 'vitest'
import { env } from 'cloudflare:test'
import {
  NEW_MEMBER, ROLL_CSV, addDoorVoter, api, countOf, setUp, submitBallot, uploadRoll, voterSignIn, type Fixture,
} from './helpers.js'

let f: Fixture

beforeEach(async () => { f = await setUp(['2400001']) })

const addVoter = (body: unknown = NEW_MEMBER) => addDoorVoter(f, body)
const removeVoter = (usuId: string) => api('DELETE', `/batches/${f.batchId}/voters/${usuId}`, f.doorCookie)
const quorum = async () =>
  await (await api('GET', `/batches/${f.batchId}/quorum`, f.doorCookie)).json() as Record<string, number>
const onRoll = (usuId: string) => countOf('voter_roll', 'usu_id = ?', usuId)
const rollRow = (usuId: string) =>
  env.DB.prepare('SELECT first_name, eligible, added_at_door FROM voter_roll WHERE usu_id = ?')
    .bind(usuId).first<{ first_name: string; eligible: number; added_at_door: number }>()

/** Adds the new member and has them vote. */
const addAndVote = async () => {
  await addVoter()
  const cookie = await voterSignIn(f.batchId, NEW_MEMBER.usu_id, NEW_MEMBER.last_name)
  return submitBallot(f.batchId, f.electionId, cookie, [f.candidateIds.a])
}

describe('adding a member the export missed', () => {
  it('adds the member, checked in and flagged, and LETS THEM VOTE', async () => {
    const before = await quorum()
    expect((await addVoter()).status).toBe(201)
    expect(await rollRow(NEW_MEMBER.usu_id)).toEqual({ first_name: 'Nina', eligible: 1, added_at_door: 1 })
    expect(await countOf('check_in', 'usu_id = ?', NEW_MEMBER.usu_id)).toBe(1)
    // counted in both totals, with added_at_door reported beside them
    expect(await quorum()).toEqual({
      ...before, eligible: before['eligible']! + 1, checked_in: before['checked_in']! + 1, added_at_door: 1,
    })
    expect((await addAndVote()).status).toBe(201)
  })

  it('REFUSES a usu_id already on the roll, leaving that member untouched and writing no check-in', async () => {
    await env.DB.prepare('DELETE FROM check_in').run()
    expect((await addVoter({ usu_id: '2400001', first_name: 'Wrong', last_name: 'Name' })).status).toBe(409)
    expect(await rollRow('2400001')).toMatchObject({ first_name: 'Ada', added_at_door: 0 })
    expect(await countOf('check_in')).toBe(0)
  })

  it.each([
    ['an empty usu_id', { usu_id: '' }],
    ['a non-numeric usu_id', { usu_id: 'abc' }],
    ['a short usu_id', { usu_id: '123' }],
    ['a usu_id with a trailing letter', { usu_id: '2400001x' }],
    ['a long usu_id', { usu_id: '24007770000' }],
    ['an empty name', { last_name: '  ' }],
  ])('rejects %s', async (_label, over) => {
    expect((await addVoter({ ...NEW_MEMBER, ...over })).status).toBe(400)
    expect(await countOf('voter_roll')).toBe(6)
  })

  it('removes a mistyped entry and its check-in, and is not an error for an unknown usu_id', async () => {
    await addVoter()
    expect((await removeVoter(NEW_MEMBER.usu_id)).status).toBe(204)
    expect(await onRoll(NEW_MEMBER.usu_id)).toBe(0)
    expect(await countOf('check_in', 'usu_id = ?', NEW_MEMBER.usu_id)).toBe(0)
    expect((await removeVoter('2400999')).status).toBe(204)
  })

  it('REFUSES to remove someone who has voted', async () => {
    await addAndVote()
    const res = await removeVoter(NEW_MEMBER.usu_id)
    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({ code: 'already_voted' })
    expect(await onRoll(NEW_MEMBER.usu_id)).toBe(1)
  })

  it('REFUSES to remove a member who came from the export', async () => {
    const res = await removeVoter('2400001')
    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({ code: 'from_export' })
    expect(await onRoll('2400001')).toBe(1)
  })

  it('keeps the flag when a corrected export later includes them', async () => {
    await addVoter()
    const [header, template] = ROLL_CSV.split('\n') as [string, string]
    const corrected = [header, template.replace('"2400001"', `"${NEW_MEMBER.usu_id}"`).replace('"Ada"', '"Corrected"')].join('\n')
    expect((await uploadRoll(f.batchId, f.officerCookie, '/roll', corrected)).status).toBe(200)
    // the import took effect, and did not clear the provenance
    expect(await rollRow(NEW_MEMBER.usu_id)).toMatchObject({ first_name: 'Corrected', added_at_door: 1 })
  })

  it('cannot add a voter to another batch', async () => {
    const res = await api('POST', `/batches/${crypto.randomUUID()}/voters`, f.doorCookie, NEW_MEMBER)
    expect(res.status).toBe(401)
    expect(await onRoll(NEW_MEMBER.usu_id)).toBe(0)
  })
})
