import { describe, it, expect, vi, afterEach } from 'vitest'
import { ApiError, officerSignIn } from '../src/api.js'
import { json, stub, stubFetch } from './helpers.js'

afterEach(() => vi.unstubAllGlobals())

describe('admin api client', () => {
  it('sends credentials, or the session cookie never travels', async () => {
    const spy = stub(200, { ok: true })
    await officerSignIn('b1', 'pw')
    expect(spy.mock.calls[0]![1]).toMatchObject({ credentials: 'include' })
  })

  it.each([
    ['the status and code of a refusal',
      () => json(403, { error: 'forbidden', code: 'wrong_role' }), { status: 403, code: 'wrong_role' }],
    ['status 0 when the request never completes',
      () => { throw new TypeError('Failed to fetch') }, { status: 0 }],
    ['the status when the body is not JSON',
      () => new Response('bad gateway', { status: 502 }), { status: 502 }],
  ])('throws an ApiError carrying %s', async (_what, respond, expected) => {
    stubFetch(respond)
    const err = await officerSignIn('b1', 'pw').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ApiError)
    expect(err).toMatchObject(expected)
  })
})
