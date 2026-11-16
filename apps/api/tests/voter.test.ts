import { describe, it, expect, beforeEach } from 'vitest'
import { env } from 'cloudflare:test'
import {
  INELIGIBLE_USU_ID, api, checkIn as checkInAt, countOf, createBatch, importRoll, setUpBatch, voterSession,
} from './helpers.js'

let batchId = ''
let doorCookie = ''

beforeEach(async () => {
  const f = await setUpBatch()
  ;({ batchId, doorCookie } = f)
  await importRoll(batchId, f.officerCookie)
})

const checkIn = (usuId: string) => checkInAt(batchId, doorCookie, usuId)
const signIn = (usuId: string, surname: string) => voterSession(batchId, usuId, surname)

describe('voter sign-in', () => {
  it('accepts a checked-in member with matching surname, with a hardened batch-scoped cookie', async () => {
    await checkIn('2400001')
    const res = await signIn('2400001', 'Lovelace')
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ first_name: 'Ada' })
    const cookie = res.headers.get('set-cookie') ?? ''
    expect(cookie).toMatch(new RegExp(`^es_voter_${batchId}=`))
    expect(cookie).toMatch(/HttpOnly/i)
    expect(cookie).toMatch(/SameSite=Strict/i)
    expect(cookie).toMatch(/Secure/i)
  })

  it.each(['LOVELACE', '  Lovelace '])('tolerates case and whitespace in the surname: "%s"', async (surname) => {
    await checkIn('2400001')
    expect((await signIn('2400001', surname)).status).toBe(200)
  })

  it('gives a wrong surname and an unknown id the same answer, naming nobody and auditing nothing', async () => {
    await checkIn('2400001')
    const wrong = await signIn('2400001', 'Wrong')
    const unknown = await signIn('9999999', 'Nobody')
    expect(wrong.status).toBe(401)
    expect(unknown.status).toBe(401)
    const text = await wrong.text()
    expect(text).toBe(await unknown.text())
    expect(text).not.toMatch(/Ada|Lovelace/)
    // Auditing every wrong guess would let an anonymous caller flood audit_log.
    expect(await countOf('audit_log', `action LIKE 'session.voter%'`)).toBe(0)
  })

  it('tells a member who is not checked in which problem it is', async () => {
    const res = await signIn('2400001', 'Lovelace')
    expect(res.status).toBe(403)
    expect(await res.json()).toMatchObject({ code: 'not_checked_in' })
  })

  it('refuses an ineligible member, even once checked in', async () => {
    expect((await signIn(INELIGIBLE_USU_ID, 'Hopper')).status).toBe(403)
    // the door refuses to check them in, so force the row: sign-in must not
    // depend on that refusal
    await env.DB.prepare('INSERT INTO check_in (batch_id, usu_id, checked_in_at) VALUES (?,?,?)')
      .bind(batchId, INELIGIBLE_USU_ID, Date.now()).run()
    const res = await signIn(INELIGIBLE_USU_ID, 'Hopper')
    expect(res.status).toBe(403)
    expect(await res.json()).toMatchObject({ code: 'ineligible' })
  })

  it('rejects a body missing the surname', async () => {
    expect((await api('POST', `/batches/${batchId}/voter/session`, '', { usu_id: '2400001' })).status).toBe(400)
  })

  it('does not sign a voter in against another batch\'s roll', async () => {
    const otherId = await createBatch('other', 2)
    await checkIn('2400001')
    expect((await voterSession(otherId, '2400001', 'Lovelace')).status).toBe(401)
  })
})
