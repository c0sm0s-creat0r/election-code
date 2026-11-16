import { describe, it, expect, beforeEach } from 'vitest'
import {
  INELIGIBLE_USU_ID, api, checkIn as checkInAt, countOf, createBatch, importRoll, setUpBatch, signIn,
} from './helpers.js'

let batchId = ''
let doorCookie = ''

beforeEach(async () => {
  const f = await setUpBatch()
  ;({ batchId, doorCookie } = f)
  await importRoll(batchId, f.officerCookie)
})

const checkIn = (usuId: string, cookie = doorCookie) => checkInAt(batchId, cookie, usuId)
const unCheck = (usuId: string) => api('DELETE', `/batches/${batchId}/check-in/${usuId}`, doorCookie)

describe('door check-in', () => {
  it('returns the roll with id, name and eligibility only', async () => {
    const res = await api('GET', `/batches/${batchId}/roll`, doorCookie)
    expect(res.status).toBe(200)
    const rows = await res.json() as Array<Record<string, unknown>>
    expect(rows).toHaveLength(6)
    expect(Object.keys(rows[0]!).sort()).toEqual(['checked_in_at', 'eligible', 'first_name', 'last_name', 'usu_id'])
  })

  it('checks a member in, idempotently', async () => {
    expect((await checkIn('2400001')).status).toBe(200)
    expect((await checkIn('2400001')).status).toBe(200)
    expect(await countOf('check_in', 'batch_id = ?', batchId)).toBe(1)
  })

  it.each([
    ['not on the roll', '9999999', 404],
    ['marked ineligible', INELIGIBLE_USU_ID, 403],
  ])('refuses a member %s, writing nothing', async (_label, usuId, status) => {
    expect((await checkIn(usuId)).status).toBe(status)
    expect(await countOf('check_in')).toBe(0)
  })

  it('rejects a body with no usu_id', async () => {
    expect((await api('POST', `/batches/${batchId}/check-in`, doorCookie, {})).status).toBe(400)
  })

  it('un-checks a member in, and is not an error when they were not', async () => {
    await checkIn('2400001')
    expect((await unCheck('2400001')).status).toBe(204)
    expect(await countOf('check_in')).toBe(0)
    expect((await unCheck('2400001')).status).toBe(204)
  })

  it('reports quorum as checked-in over eligible', async () => {
    await checkIn('2400001')
    await checkIn('2400002')
    const res = await api('GET', `/batches/${batchId}/quorum`, doorCookie)
    expect(await res.json()).toEqual({ checked_in: 2, eligible: 4, guests: 0, added_at_door: 0 })
  })

  it('cannot check in a member with another batch\'s door session', async () => {
    const otherId = await createBatch('other', 2)
    const otherDoor = await signIn(otherId, 'door', 'door-password-2')
    expect((await checkIn('2400001', otherDoor)).status).toBe(401)
    expect(await countOf('check_in')).toBe(0)
  })
})
