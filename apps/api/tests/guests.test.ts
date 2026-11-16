import { describe, it, expect, beforeEach } from 'vitest'
import { env } from 'cloudflare:test'
import { addGuest, api, countOf, createBatch, setUp, signIn, type Fixture } from './helpers.js'

let f: Fixture

beforeEach(async () => { f = await setUp(['2400001']) })

const guests = async () => await (await api('GET', `/batches/${f.batchId}/guests`, f.doorCookie)).json() as Array<Record<string, unknown>>
const removeGuest = (id: string, batchId = f.batchId, cookie = f.doorCookie) =>
  api('DELETE', `/batches/${batchId}/guests/${id}`, cookie)
const quorum = async () => await (await api('GET', `/batches/${f.batchId}/quorum`, f.doorCookie)).json() as Record<string, number>
const idOf = async (res: Response) => (await res.json() as { id: string }).id

describe('guests', () => {
  it('adds a guest, with or without a note, and lists them for the door', async () => {
    const res = await addGuest(f, { name: 'Jo Visitor', note: 'observer' })
    expect(res.status).toBe(201)
    expect(await res.json()).toMatchObject({ name: 'Jo Visitor' })
    expect((await addGuest(f, { name: 'No Note' })).status).toBe(201)
    const rows = await guests()
    expect(rows).toHaveLength(2)
    expect(Object.keys(rows[0]!).sort()).toEqual(['checked_in_at', 'id', 'name', 'note'])
  })

  it('rejects an empty name', async () => {
    expect((await addGuest(f, { name: '   ' })).status).toBe(400)
  })

  it('A GUEST IS NOT A VOTER: no roll row, no check-in, and quorum counts them apart', async () => {
    // With no roll row there is nothing to check in or sign in as
    // (checkIn.test.ts, voter.test.ts).
    const before = { quorum: await quorum(), roll: await countOf('voter_roll'), checkIns: await countOf('check_in') }
    await addGuest(f)
    expect({ quorum: { ...await quorum(), guests: 0 }, roll: await countOf('voter_roll'), checkIns: await countOf('check_in') })
      .toEqual(before)
    expect((await quorum())['guests']).toBe(1)
  })

  it('removes a guest, is not an error for an unknown one, and audits both actions with NO name', async () => {
    const id = await idOf(await addGuest(f, { name: 'Jo Verydistinctive' }))
    expect((await removeGuest(id)).status).toBe(204)
    expect(await guests()).toEqual([])
    expect((await removeGuest(crypto.randomUUID())).status).toBe(204)

    const rows = await env.DB.prepare(`SELECT action, detail FROM audit_log WHERE action LIKE 'guest%' ORDER BY id`).all()
    expect(rows.results.slice(0, 2)).toEqual([{ action: 'guest.add', detail: null }, { action: 'guest.remove', detail: null }])
    const all = await env.DB.prepare('SELECT * FROM audit_log').all()
    expect(JSON.stringify(all.results)).not.toMatch(/Verydistinctive/)
  })

  it('cannot remove another batch\'s guest', async () => {
    const id = await idOf(await addGuest(f, { name: 'Ours' }))
    const otherId = await createBatch('other', 2)
    await removeGuest(id, otherId, await signIn(otherId, 'door', 'door-password-2'))
    expect(await countOf('guest')).toBe(1)
  })
})
