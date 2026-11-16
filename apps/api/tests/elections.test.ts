import { describe, it, expect, beforeEach } from 'vitest'
import { env } from 'cloudflare:test'
import {
  api, countOf, createBatch, createElection, openElection, setUpBatch, signIn,
} from './helpers.js'

let batchId = ''
let officerCookie = ''

beforeEach(async () => {
  ({ batchId, officerCookie } = await setUpBatch())
})

const base = () => `/batches/${batchId}/elections`
const newElection = (name = 'President', seats = 1) => createElection(batchId, officerCookie, name, seats)
const addCandidate = (eid: string, name: string) => api('POST', `${base()}/${eid}/candidates`, officerCookie, { name })
const open = (eid: string) => openElection(batchId, officerCookie, eid)
const idOf = async (res: Response) => (await res.json() as { id: string }).id

/** An open election with Alex and Bo; returns Alex's id too. */
const openedElection = async () => {
  const eid = await newElection()
  const cid = await idOf(await addCandidate(eid, 'Alex'))
  await addCandidate(eid, 'Bo')
  await open(eid)
  return { eid, cid }
}

/** A second society and its officer. */
const otherSociety = async () => {
  const otherId = await createBatch('other', 2)
  return { otherId, otherCookie: await signIn(otherId, 'officer', 'officer-password-2') }
}

describe('election lifecycle', () => {
  it('creates an election in draft', async () => {
    const res = await api('POST', base(), officerCookie, { name: 'President', seats: 1 })
    expect(res.status).toBe(201)
    expect(await res.json()).toMatchObject({ name: 'President', seats: 1, status: 'draft' })
  })

  it('rejects seats below 1', async () => {
    expect((await api('POST', base(), officerCookie, { name: 'x', seats: 0 })).status).toBe(400)
  })

  it('adds, edits and deletes a candidate while in draft', async () => {
    const eid = await newElection()
    const added = await addCandidate(eid, 'Alex')
    expect(added.status).toBe(201)
    const path = `${base()}/${eid}/candidates/${await idOf(added)}`
    expect((await api('PATCH', path, officerCookie, { name: 'Alexandra' })).status).toBe(200)
    expect((await api('DELETE', path, officerCookie)).status).toBe(204)
    expect(await countOf('candidate', 'election_id = ?', eid)).toBe(0)
  })

  it.each([
    ['no candidates', 1, 0],
    ['fewer candidates than seats', 3, 1],
  ])('refuses to open an election with %s', async (_label, seats, candidates) => {
    const eid = await newElection('President', seats)
    for (let i = 0; i < candidates; i++) await addCandidate(eid, `Candidate ${i}`)
    const res = await open(eid)
    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({ error: expect.stringMatching(/candidate/i) })
  })

  it('opens an election once, and FREEZES its candidates', async () => {
    const eid = await newElection()
    const cid = await idOf(await addCandidate(eid, 'Alex'))
    await addCandidate(eid, 'Bo')
    expect((await open(eid)).status).toBe(200)
    expect((await open(eid)).status).toBe(409)

    expect((await addCandidate(eid, 'Late Entry')).status).toBe(409)
    const path = `${base()}/${eid}/candidates/${cid}`
    expect((await api('PATCH', path, officerCookie, { name: 'Renamed' })).status).toBe(409)
    expect((await api('DELETE', path, officerCookie)).status).toBe(409)
    const { results } = await env.DB.prepare('SELECT name FROM candidate WHERE election_id = ? ORDER BY name')
      .bind(eid).all<{ name: string }>()
    expect(results.map((r) => r.name)).toEqual(['Alex', 'Bo'])
  })

  it('refuses to open an election belonging to another batch', async () => {
    const eid = await newElection()
    await addCandidate(eid, 'Alex')
    // the other batch's officer, on their own batch's path, naming our election
    const { otherId, otherCookie } = await otherSociety()
    expect((await openElection(otherId, otherCookie, eid)).status).toBe(404)
    expect(await countOf('election', `id = ? AND status = 'draft'`, eid)).toBe(1)
  })
})

describe('election listings', () => {
  it('shows the public open elections only, with candidates in ballot order and nothing else', async () => {
    await newElection('Draft One')
    await openedElection()
    const res = await api('GET', base())
    expect(res.status).toBe(200)
    const list = await res.json() as Array<{ candidates: Array<Record<string, unknown>> }>
    // drafts are hidden; no ballots, no attendees
    expect(list).toHaveLength(1)
    expect(Object.keys(list[0]!).sort()).toEqual(['candidates', 'id', 'name', 'seats', 'status'])
    expect(list[0]!.candidates.map((x) => x['name'])).toEqual(['Alex', 'Bo'])
    expect(Object.keys(list[0]!.candidates[0]!).sort()).toEqual(['id', 'name'])
  })

  it('shows the officer DRAFTS too, with their candidates', async () => {
    const draft = await newElection('Draft One')
    await addCandidate(draft, 'Dee')
    await openedElection()
    const list = await (await api('GET', `/batches/${batchId}/officer/elections`, officerCookie)).json() as
      Array<{ name: string; status: string; candidates: { name: string }[] }>
    expect(list.map((e) => e.status).sort()).toEqual(['draft', 'open'])
    expect(list.find((e) => e.name === 'Draft One')!.candidates.map((c) => c.name)).toEqual(['Dee'])
  })

  it('lists nothing from another batch, publicly or to its officer', async () => {
    await openedElection()
    const { otherId, otherCookie } = await otherSociety()
    expect(await (await api('GET', `/batches/${otherId}/elections`)).json()).toEqual([])
    expect(await (await api('GET', `/batches/${otherId}/officer/elections`, otherCookie)).json()).toEqual([])
  })
})
