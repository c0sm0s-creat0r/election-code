import { describe, it, expect, beforeEach } from 'vitest'
import { SELF, env } from 'cloudflare:test'
import {
  JSON_HEADERS as json, setUpBatch, createBatch, signIn,
  createElection as createElectionId, openElection as openById,
} from './helpers'

let batchId = ''
let officerCookie = ''
let doorCookie = ''

beforeEach(async () => {
  ({ batchId, officerCookie, doorCookie } = await setUpBatch())
})

const createElection = (body: { name: string; seats: number }, cookie = officerCookie) =>
  SELF.fetch(`https://example.com/api/batches/${batchId}/elections`, {
    method: 'POST', headers: { ...json, cookie }, body: JSON.stringify(body),
  })

const newElection = (body: { name?: string; seats?: number } = {}) =>
  createElectionId(batchId, officerCookie, body.name ?? 'President', body.seats ?? 1)

const addCandidate = (eid: string, name: string, cookie = officerCookie) =>
  SELF.fetch(`https://example.com/api/batches/${batchId}/elections/${eid}/candidates`, {
    method: 'POST', headers: { ...json, cookie }, body: JSON.stringify({ name }),
  })

const patchCandidate = (eid: string, cid: string, name: string) =>
  SELF.fetch(`https://example.com/api/batches/${batchId}/elections/${eid}/candidates/${cid}`, {
    method: 'PATCH', headers: { ...json, cookie: officerCookie }, body: JSON.stringify({ name }),
  })

const deleteCandidate = (eid: string, cid: string) =>
  SELF.fetch(`https://example.com/api/batches/${batchId}/elections/${eid}/candidates/${cid}`, {
    method: 'DELETE', headers: { cookie: officerCookie },
  })

const open = (eid: string) => openById(batchId, officerCookie, eid)

const openElection = async () => {
  const eid = await newElection()
  await addCandidate(eid, 'Alex')
  await addCandidate(eid, 'Bo')
  await open(eid)
  return eid
}

const openElectionWithCandidate = async () => {
  const eid = await newElection()
  const res = await addCandidate(eid, 'Alex')
  const cid = (await res.json() as { id: string }).id
  await addCandidate(eid, 'Bo')
  await open(eid)
  return { eid, cid }
}

describe('election lifecycle', () => {
  it('creates an election in draft', async () => {
    const res = await createElection({ name: 'President', seats: 1 })
    expect(res.status).toBe(201)
    expect(await res.json()).toMatchObject({ name: 'President', seats: 1, status: 'draft' })
  })

  it('requires an officer session', async () => {
    expect((await createElection({ name: 'x', seats: 1 }, '')).status).toBe(401)
  })

  it('refuses a door session', async () => {
    expect((await createElection({ name: 'x', seats: 1 }, doorCookie)).status).toBe(403)
  })

  it('rejects seats below 1', async () => {
    expect((await createElection({ name: 'x', seats: 0 })).status).toBe(400)
  })

  it('adds candidates while in draft', async () => {
    const eid = await newElection()
    expect((await addCandidate(eid, 'Alex')).status).toBe(201)
  })

  it('refuses to open an election with no candidates', async () => {
    const eid = await newElection()
    const res = await open(eid)
    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({ error: expect.stringMatching(/candidate/i) })
  })

  it('refuses to open with fewer candidates than seats', async () => {
    const eid = await newElection({ seats: 3 })
    await addCandidate(eid, 'Only One')
    expect((await open(eid)).status).toBe(409)
  })

  it('opens an election', async () => {
    const eid = await newElection()
    await addCandidate(eid, 'Alex'); await addCandidate(eid, 'Bo')
    expect((await open(eid)).status).toBe(200)
  })

  it('FREEZES candidates once open', async () => {
    const eid = await openElection()
    expect((await addCandidate(eid, 'Late Entry')).status).toBe(409)
  })

  it('writes no candidate row for a refused late entry', async () => {
    const eid = await openElection()
    await addCandidate(eid, 'Late Entry')
    const row = await env.DB.prepare('SELECT count(*) c FROM candidate WHERE election_id = ?').bind(eid).first<{ c: number }>()
    expect(row!.c).toBe(2)
  })

  it('refuses to edit or delete a candidate once open', async () => {
    const { eid, cid } = await openElectionWithCandidate()
    expect((await patchCandidate(eid, cid, 'Renamed')).status).toBe(409)
    expect((await deleteCandidate(eid, cid)).status).toBe(409)
  })

  it('edits and deletes a candidate while in draft', async () => {
    const eid = await newElection()
    const cid = (await (await addCandidate(eid, 'Alex')).json() as { id: string }).id
    expect((await patchCandidate(eid, cid, 'Alexandra')).status).toBe(200)
    expect((await deleteCandidate(eid, cid)).status).toBe(204)
    const row = await env.DB.prepare('SELECT count(*) c FROM candidate WHERE election_id = ?').bind(eid).first<{ c: number }>()
    expect(row!.c).toBe(0)
  })

  it('refuses to open an election twice', async () => {
    const eid = await openElection()
    expect((await open(eid)).status).toBe(409)
  })

  it('never exposes ballots or attendees on the public election listing', async () => {
    await openElection()
    const res = await SELF.fetch(`https://example.com/api/batches/${batchId}/elections`)
    expect(res.status).toBe(200)
    const list = await res.json() as Array<Record<string, unknown>>
    expect(Object.keys(list[0]!).sort()).toEqual(['candidates', 'id', 'name', 'seats', 'status'])
  })

  it('hides draft elections from the public listing', async () => {
    await newElection()
    const res = await SELF.fetch(`https://example.com/api/batches/${batchId}/elections`)
    expect(await res.json()).toEqual([])
  })

  it('lists candidates in ballot order with id and name only', async () => {
    await openElection()
    const res = await SELF.fetch(`https://example.com/api/batches/${batchId}/elections`)
    const list = await res.json() as Array<{ candidates: Array<Record<string, unknown>> }>
    expect(list[0]!.candidates.map((x) => x['name'])).toEqual(['Alex', 'Bo'])
    expect(Object.keys(list[0]!.candidates[0]!).sort()).toEqual(['id', 'name'])
  })

  it('does not list another batch\'s elections', async () => {
    await openElection()
    const otherId = await createBatch('other', 2)
    const res = await SELF.fetch(`https://example.com/api/batches/${otherId}/elections`)
    expect(await res.json()).toEqual([])
  })

  it('refuses to open an election belonging to another batch', async () => {
    const eid = await newElection()
    await addCandidate(eid, 'Alex')
    const otherId = await createBatch('other2', 2)
    const otherCookie = await signIn(otherId, 'officer', 'officer-password-2')
    // the other batch's officer, on their own batch's path, naming our election
    const res = await SELF.fetch(`https://example.com/api/batches/${otherId}/elections/${eid}/open`, {
      method: 'POST', headers: { cookie: otherCookie },
    })
    expect(res.status).toBe(404)
    const row = await env.DB.prepare('SELECT status FROM election WHERE id = ?').bind(eid).first<{ status: string }>()
    expect(row!.status).toBe('draft')
  })

  it('records an audit row on open carrying counts only', async () => {
    const eid = await openElection()
    const row = await env.DB.prepare(`SELECT detail FROM audit_log WHERE action = 'election.open'`).first<{ detail: string }>()
    expect(JSON.parse(row!.detail)).toMatchObject({ kind: 'election_open', seats: 1, candidates: 2 })
    expect(eid).toBeTruthy()
  })

})

describe('officer election listing', () => {
  const officerList = (cookie = officerCookie) =>
    SELF.fetch(`https://example.com/api/batches/${batchId}/officer/elections`, { headers: { cookie } })

  it('requires an officer session', async () => {
    expect((await officerList('')).status).toBe(401)
  })

  it('refuses a door session', async () => {
    expect((await officerList(doorCookie)).status).toBe(403)
  })

  it('INCLUDES DRAFTS, which the public listing deliberately hides', async () => {
    await newElection({ name: 'Draft One' })
    await openElection()
    const list = await (await officerList()).json() as Array<{ name: string; status: string }>
    expect(list.map((e) => e.status).sort()).toEqual(['draft', 'open'])
    expect(list.map((e) => e.name)).toContain('Draft One')
  })

  it('carries the candidates, so the officer can see what will be frozen', async () => {
    const eid = await newElection()
    await addCandidate(eid, 'Alex')
    const list = await (await officerList()).json() as Array<{ candidates: { name: string }[] }>
    expect(list[0]!.candidates.map((c) => c.name)).toEqual(['Alex'])
  })

  it('does not list another batch\'s elections', async () => {
    await newElection()
    const otherId = await createBatch('other-list', 2)
    const otherCookie = await signIn(otherId, 'officer', 'officer-password-2')
    const res = await SELF.fetch(`https://example.com/api/batches/${otherId}/officer/elections`, {
      headers: { cookie: otherCookie },
    })
    expect(await res.json()).toEqual([])
  })
})
