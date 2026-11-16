import { describe, it, expect, beforeEach } from 'vitest'
import { SELF, env } from 'cloudflare:test'
import {
  JSON_HEADERS, INELIGIBLE_USU_ID, setUpBatch, createBatch, importRoll,
  checkIn as checkInAt, voterSession,
} from './helpers'

const INELIGIBLE_SURNAME = 'Hopper'

let batchId = ''
let doorCookie = ''

beforeEach(async () => {
  const f = await setUpBatch()
  ;({ batchId, doorCookie } = f)
  await importRoll(batchId, f.officerCookie)
})

const checkIn = (usuId: string) => checkInAt(batchId, doorCookie, usuId)
const voterSignIn = (usuId: string, surname: string) => voterSession(batchId, usuId, surname)

describe('voter sign-in', () => {
  it('accepts a checked-in member with matching surname', async () => {
    await checkIn('2400001')
    const res = await voterSignIn('2400001', 'Lovelace')
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ first_name: 'Ada' })
    expect(res.headers.get('set-cookie') ?? '').toMatch(/HttpOnly/i)
  })

  it('is case-insensitive on the surname', async () => {
    await checkIn('2400001')
    expect((await voterSignIn('2400001', 'LOVELACE')).status).toBe(200)
  })

  it('tolerates surrounding whitespace on the surname', async () => {
    await checkIn('2400001')
    expect((await voterSignIn('2400001', '  Lovelace ')).status).toBe(200)
  })

  it('refuses a wrong surname', async () => {
    await checkIn('2400001')
    expect((await voterSignIn('2400001', 'Wrong')).status).toBe(401)
  })

  it('refuses a member who is not checked in', async () => {
    expect((await voterSignIn('2400001', 'Lovelace')).status).toBe(403)
  })

  it('tells a not-checked-in voter which problem it is', async () => {
    expect(await (await voterSignIn('2400001', 'Lovelace')).json())
      .toMatchObject({ code: 'not_checked_in' })
  })

  it('refuses a member marked ineligible', async () => {
    expect((await voterSignIn(INELIGIBLE_USU_ID, INELIGIBLE_SURNAME)).status).toBe(403)
  })

  it('refuses an ineligible member even once checked in', async () => {
    // the door refuses to check them in, so force the row: sign-in must not
    // depend on that refusal
    await env.DB.prepare('INSERT INTO check_in (batch_id, usu_id, checked_in_at) VALUES (?,?,?)')
      .bind(batchId, INELIGIBLE_USU_ID, Date.now()).run()
    const res = await voterSignIn(INELIGIBLE_USU_ID, INELIGIBLE_SURNAME)
    expect(res.status).toBe(403)
    expect(await res.json()).toMatchObject({ code: 'ineligible' })
  })

  it('gives an unknown id and a wrong surname the same answer', async () => {
    const unknown = await voterSignIn('9999999', 'Nobody')
    const wrong = await voterSignIn('2400001', 'Wrong')
    expect(unknown.status).toBe(wrong.status)
    expect(await unknown.json()).toEqual(await wrong.json())
  })

  it('never returns another member\'s name on a wrong surname', async () => {
    await checkIn('2400001')
    const text = await (await voterSignIn('2400001', 'Wrong')).text()
    expect(text).not.toMatch(/Ada|Lovelace/)
  })

  it('issues a voter session scoped to this batch', async () => {
    await checkIn('2400001')
    const cookie = (await voterSignIn('2400001', 'Lovelace')).headers.get('set-cookie') ?? ''
    expect(cookie).toMatch(new RegExp(`es_voter_${batchId}=`))
  })

  it('sets the cookie SameSite=Strict and Secure', async () => {
    await checkIn('2400001')
    const cookie = (await voterSignIn('2400001', 'Lovelace')).headers.get('set-cookie') ?? ''
    expect(cookie).toMatch(/SameSite=Strict/i)
    expect(cookie).toMatch(/Secure/i)
  })

  it('records sign-in in the audit log with NO usu_id', async () => {
    await checkIn('2400001')
    await voterSignIn('2400001', 'Lovelace')
    const rows = await env.DB.prepare(`SELECT action, detail FROM audit_log WHERE action LIKE 'session.voter%'`).all<{ action: string; detail: string | null }>()
    expect(rows.results.map((r) => r.action)).toEqual(['session.voter.ok'])
    for (const r of rows.results) expect(r.detail).toBeNull()
  })

  it('does NOT audit an unauthenticated miss', async () => {
    // Auditing every wrong guess would let an anonymous caller flood audit_log.
    await voterSignIn('9999999', 'Nobody')
    await voterSignIn('2400001', 'Wrong')
    const row = await env.DB.prepare(`SELECT count(*) c FROM audit_log WHERE action LIKE 'session.voter%'`).first<{ c: number }>()
    expect(row!.c).toBe(0)
  })

  it('DOES audit a refusal that names a real roll member', async () => {
    // Bounded by the roll: the caller already has a valid id and surname.
    await env.DB.prepare('INSERT INTO check_in (batch_id, usu_id, checked_in_at) VALUES (?,?,?)')
      .bind(batchId, INELIGIBLE_USU_ID, Date.now()).run()
    await voterSignIn(INELIGIBLE_USU_ID, INELIGIBLE_SURNAME)
    const rows = await env.DB.prepare(`SELECT action, detail FROM audit_log WHERE action = 'session.voter.fail'`).all<{ detail: string | null }>()
    expect(rows.results).toHaveLength(1)
    expect(rows.results[0]!.detail).toBeNull()
  })

  it('rejects a body missing the surname', async () => {
    const res = await SELF.fetch(`https://example.com/api/batches/${batchId}/voter/session`, {
      method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ usu_id: '2400001' }),
    })
    expect(res.status).toBe(400)
  })

  it('does not sign a voter in against another batch\'s roll', async () => {
    const otherId = await createBatch('other', 2)
    await checkIn('2400001')
    const res = await voterSession(otherId, '2400001', 'Lovelace')
    expect(res.status).toBe(401)
  })
})
