import { describe, it, expect, vi, afterEach } from 'vitest'
import { ApiError, getBatchBySlug, voterSignIn, submitBallot } from '../src/api.js'
import { json, stub, stubFetch } from './helpers.js'

afterEach(() => vi.unstubAllGlobals())

describe('api client', () => {
  it('sends credentials, or the session cookie never travels', async () => {
    const spy = stub(200, { first_name: 'Ada' })
    await voterSignIn('b1', '2400001', 'Lovelace')
    expect(spy.mock.calls[0]![1]).toMatchObject({ credentials: 'include' })
  })

  it.each([
    ['the status and code of a refusal',
      () => json(403, { error: 'not checked in', code: 'not_checked_in' }), { status: 403, code: 'not_checked_in' }],
    ['status 0 when the request never completes',
      () => { throw new TypeError('Failed to fetch') }, { status: 0 }],
    ['the status when the body is not JSON',
      () => new Response('gateway timeout', { status: 504 }), { status: 504 }],
  ])('throws an ApiError carrying %s', async (_what, respond, expected) => {
    stubFetch(respond)
    const err = await voterSignIn('b1', '2400001', 'Lovelace').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ApiError)
    expect(err).toMatchObject(expected)
  })

  it('never puts the usu_id in a ballot body — the session carries it', async () => {
    const spy = stub(201, { receipt_token: 't' })
    await submitBallot('b1', 'e1', ['a', 'b'])
    expect(spy.mock.calls[0]![1]!.body).toBe(JSON.stringify({ preferences: ['a', 'b'] }))
  })

  it('encodes a slug that would otherwise break the path', async () => {
    const spy = stub(200, {})
    await getBatchBySlug('a/b')
    expect(spy.mock.calls[0]![0]).toContain('a%2Fb')
  })
})
