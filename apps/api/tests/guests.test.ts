import { describe, it, expect, beforeEach } from 'vitest'
import { SELF, env } from 'cloudflare:test'
import { setUp, JSON_HEADERS, SUPER_KEY, type Fixture } from './helpers.js'

let f: Fixture

beforeEach(async () => { f = await setUp(['2400001']) })

const addGuest = (body: unknown, cookie = f.doorCookie) =>
  SELF.fetch(`https://example.com/api/batches/${f.batchId}/guests`, {
    method: 'POST', headers: { ...JSON_HEADERS, cookie }, body: JSON.stringify(body),
  })

const listGuests = (cookie = f.doorCookie) =>
  SELF.fetch(`https://example.com/api/batches/${f.batchId}/guests`, { headers: { cookie } })

const removeGuest = (id: string, cookie = f.doorCookie) =>
  SELF.fetch(`https://example.com/api/batches/${f.batchId}/guests/${id}`, {
    method: 'DELETE', headers: { cookie },
  })

const quorum = () =>
  SELF.fetch(`https://example.com/api/batches/${f.batchId}/quorum`, { headers: { cookie: f.doorCookie } })

describe('guests', () => {
  it('requires a door session', async () => {
    expect((await addGuest({ name: 'Visitor' }, '')).status).toBe(401)
  })

  it('refuses an officer session', async () => {
    expect((await addGuest({ name: 'Visitor' }, f.officerCookie)).status).toBe(403)
  })

  it('adds a guest', async () => {
    const res = await addGuest({ name: 'Jo Visitor', note: 'observer' })
    expect(res.status).toBe(201)
    expect(await res.json()).toMatchObject({ name: 'Jo Visitor' })
  })

  it('accepts a guest with no note', async () => {
    expect((await addGuest({ name: 'Jo Visitor' })).status).toBe(201)
  })

  it('rejects an empty name', async () => {
    expect((await addGuest({ name: '   ' })).status).toBe(400)
  })

  it('lists guests for the door', async () => {
    await addGuest({ name: 'Jo Visitor', note: 'observer' })
    const rows = await (await listGuests()).json() as Array<Record<string, unknown>>
    expect(rows).toHaveLength(1)
    expect(Object.keys(rows[0]!).sort()).toEqual(['checked_in_at', 'id', 'name', 'note'])
  })

  it('removes a guest, because a mistaken tap needs undoing', async () => {
    const { id } = await (await addGuest({ name: 'Typo' })).json() as { id: string }
    expect((await removeGuest(id)).status).toBe(204)
    expect(await (await listGuests()).json()).toEqual([])
  })

  it('removing an unknown guest is not an error', async () => {
    expect((await removeGuest(crypto.randomUUID())).status).toBe(204)
  })

  it('cannot remove another batch\'s guest', async () => {
    const { id } = await (await addGuest({ name: 'Ours' })).json() as { id: string }
    const other = await (await SELF.fetch('https://example.com/api/batches', {
      method: 'POST',
      headers: { ...JSON_HEADERS, 'x-super-admin-key': SUPER_KEY },
      body: JSON.stringify({
        name: 'Other', slug: 'other', officer_password: 'officer-password-2', door_password: 'door-password-2',
        branding: { title: 't', org_name: 'o', accent_color: '#000000', logo_url: '' },
      }),
    })).json() as { id: string }
    const otherDoor = ((await (await SELF.fetch(`https://example.com/api/batches/${other.id}/door/session`, {
      method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ password: 'door-password-2' }),
    })).headers.get('set-cookie')) ?? '').split(';')[0]!
    await SELF.fetch(`https://example.com/api/batches/${other.id}/guests/${id}`, {
      method: 'DELETE', headers: { cookie: otherDoor },
    })
    const row = await env.DB.prepare('SELECT count(*) c FROM guest').first<{ c: number }>()
    expect(row!.c).toBe(1)
  })

  it('A GUEST IS NOT ON THE ROLL, so they cannot be checked in as a voter', async () => {
    const before = await env.DB.prepare('SELECT count(*) c FROM voter_roll').first<{ c: number }>()
    await addGuest({ name: 'Jo Visitor' })
    // adding a guest creates no roll row: that is the control
    const after = await env.DB.prepare('SELECT count(*) c FROM voter_roll').first<{ c: number }>()
    expect(after!.c).toBe(before!.c)
    // Nothing absent from the roll can be checked in. A guest id is a 36-char
    // UUID, which checkInSchema's max(32) rejects with a 400, so this uses a
    // well-formed id that is not on the roll.
    const res = await SELF.fetch(`https://example.com/api/batches/${f.batchId}/check-in`, {
      method: 'POST', headers: { ...JSON_HEADERS, cookie: f.doorCookie },
      body: JSON.stringify({ usu_id: '9999999' }),
    })
    expect(res.status).toBe(404)
  })

  it('A GUEST CANNOT SIGN IN TO VOTE', async () => {
    await addGuest({ name: 'Jo Visitor' })
    const res = await SELF.fetch(`https://example.com/api/batches/${f.batchId}/voter/session`, {
      method: 'POST', headers: JSON_HEADERS,
      body: JSON.stringify({ usu_id: '9999999', surname: 'Visitor' }),
    })
    expect(res.status).toBe(401)
  })

  it('reports guests in quorum WITHOUT moving checked_in or eligible', async () => {
    const before = await (await quorum()).json() as Record<string, number>
    await addGuest({ name: 'Jo Visitor' })
    const after = await (await quorum()).json() as Record<string, number>
    expect(after['guests']).toBe(1)
    expect({ ...after, guests: 0 }).toEqual(before)
  })

  it('records add and remove in the audit log with NO name', async () => {
    const { id } = await (await addGuest({ name: 'Jo Verydistinctive' })).json() as { id: string }
    await removeGuest(id)
    const rows = await env.DB.prepare(`SELECT action, detail FROM audit_log WHERE action LIKE 'guest%'`)
      .all<{ action: string; detail: string | null }>()
    expect(rows.results.map((r) => r.action).sort()).toEqual(['guest.add', 'guest.remove'])
    for (const r of rows.results) expect(r.detail).toBeNull()
    const all = await env.DB.prepare('SELECT * FROM audit_log').all()
    expect(JSON.stringify(all.results)).not.toMatch(/Verydistinctive/)
  })
})
