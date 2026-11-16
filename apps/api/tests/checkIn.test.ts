import { describe, it, expect, beforeEach } from 'vitest'
import { SELF, env } from 'cloudflare:test'
import {
  JSON_HEADERS, INELIGIBLE_USU_ID, setUpBatch, createBatch, signIn, importRoll,
  checkIn as checkInAt,
} from './helpers'

let batchId = ''
let officerCookie = ''
let doorCookie = ''

beforeEach(async () => {
  ({ batchId, officerCookie, doorCookie } = await setUpBatch())
  await importRoll(batchId, officerCookie)
})

const checkIn = (usuId: string, cookie = doorCookie) => checkInAt(batchId, cookie, usuId)

describe('door check-in', () => {
  it('requires a door session', async () => {
    expect((await SELF.fetch(`https://example.com/api/batches/${batchId}/roll`)).status).toBe(401)
  })

  it('rejects an officer session on a door route', async () => {
    const res = await SELF.fetch(`https://example.com/api/batches/${batchId}/roll`, { headers: { cookie: officerCookie } })
    expect(res.status).toBe(403)
  })

  it('returns the roll with id, name and eligibility only', async () => {
    const res = await SELF.fetch(`https://example.com/api/batches/${batchId}/roll`, { headers: { cookie: doorCookie } })
    expect(res.status).toBe(200)
    const rows = await res.json() as Array<Record<string, unknown>>
    expect(rows).toHaveLength(6)
    expect(Object.keys(rows[0]!).sort()).toEqual(['checked_in_at', 'eligible', 'first_name', 'last_name', 'usu_id'])
  })

  it('checks a member in', async () => {
    const res = await checkIn('2400001')
    expect(res.status).toBe(200)
    const row = await env.DB.prepare('SELECT count(*) c FROM check_in WHERE batch_id = ?').bind(batchId).first<{ c: number }>()
    expect(row!.c).toBe(1)
  })

  it('is idempotent — checking in twice is not an error and does not duplicate', async () => {
    await checkIn('2400001')
    expect((await checkIn('2400001')).status).toBe(200)
    const row = await env.DB.prepare('SELECT count(*) c FROM check_in').first<{ c: number }>()
    expect(row!.c).toBe(1)
  })

  it('refuses a member who is not on the roll', async () => {
    expect((await checkIn('9999999')).status).toBe(404)
  })

  it('refuses a member marked ineligible', async () => {
    expect((await checkIn(INELIGIBLE_USU_ID)).status).toBe(403)
  })

  it('writes nothing for an ineligible member', async () => {
    await checkIn(INELIGIBLE_USU_ID)
    const row = await env.DB.prepare('SELECT count(*) c FROM check_in').first<{ c: number }>()
    expect(row!.c).toBe(0)
  })

  it('un-checks a member in', async () => {
    await checkIn('2400001')
    const res = await SELF.fetch(`https://example.com/api/batches/${batchId}/check-in/2400001`, {
      method: 'DELETE', headers: { cookie: doorCookie },
    })
    expect(res.status).toBe(204)
    const row = await env.DB.prepare('SELECT count(*) c FROM check_in').first<{ c: number }>()
    expect(row!.c).toBe(0)
  })

  it('un-checking someone who is not checked in is not an error', async () => {
    const res = await SELF.fetch(`https://example.com/api/batches/${batchId}/check-in/2400001`, {
      method: 'DELETE', headers: { cookie: doorCookie },
    })
    expect(res.status).toBe(204)
  })

  it('reports quorum as checked-in over eligible', async () => {
    await checkIn('2400001')
    await checkIn('2400002')
    const res = await SELF.fetch(`https://example.com/api/batches/${batchId}/quorum`, { headers: { cookie: doorCookie } })
    expect(await res.json()).toEqual({ checked_in: 2, eligible: 4, guests: 0, added_at_door: 0 })
  })

  it('never lets the door role reach an officer route', async () => {
    const res = await SELF.fetch(`https://example.com/api/batches/${batchId}/officer/ping`, { headers: { cookie: doorCookie } })
    expect(res.status).toBe(403)
  })

  it('records check-in in the audit log with NO usu_id', async () => {
    await checkIn('2400001')
    await SELF.fetch(`https://example.com/api/batches/${batchId}/check-in/2400001`, {
      method: 'DELETE', headers: { cookie: doorCookie },
    })
    const rows = await env.DB.prepare(`SELECT action, detail FROM audit_log WHERE action LIKE 'check_in%'`).all<{ action: string; detail: string | null }>()
    expect(rows.results.map((r) => r.action).sort()).toEqual(['check_in.add', 'check_in.remove'])
    for (const r of rows.results) expect(r.detail).toBeNull()
  })

  it('cannot check in a member of another batch', async () => {
    const otherId = await createBatch('other', 2)
    // a door cookie for the other batch, used on this batch's route
    const otherDoor = await signIn(otherId, 'door', 'door-password-2')
    const res = await checkIn('2400001', otherDoor)
    expect(res.status).toBe(401)
    const row = await env.DB.prepare('SELECT count(*) c FROM check_in').first<{ c: number }>()
    expect(row!.c).toBe(0)
  })

  it('rejects a body with no usu_id', async () => {
    const res = await SELF.fetch(`https://example.com/api/batches/${batchId}/check-in`, {
      method: 'POST', headers: { ...JSON_HEADERS, cookie: doorCookie },
      body: JSON.stringify({}),
    })
    expect(res.status).toBe(400)
  })
})
