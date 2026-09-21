import { describe, it, expect, vi, afterEach } from 'vitest'
import { ApiError, voterSignIn, submitBallot } from '../src/api.js'

const mockFetch = (status: number, body: unknown) =>
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(body), {
    status, headers: { 'content-type': 'application/json' },
  })))

/**
 * A spy whose parameters are declared, so `mock.calls[0]` is a real tuple. A
 * bare `vi.fn(async () => …)` types its calls as `[]`, and every assertion about
 * what was sent becomes a type error.
 */
const spyFetch = (respond: () => Response) =>
  vi.fn(async (_url: string, _init?: RequestInit) => respond())

afterEach(() => vi.unstubAllGlobals())

describe('api client', () => {
  it('sends credentials, or the session cookie never travels', async () => {
    const spy = spyFetch(() => new Response(JSON.stringify({ first_name: 'Ada' }), { status: 200 }))
    vi.stubGlobal('fetch', spy)
    await voterSignIn('b1', '2400001', 'Lovelace')
    expect(spy.mock.calls[0]![1]).toMatchObject({ credentials: 'include' })
  })

  it('returns the body on success', async () => {
    mockFetch(200, { first_name: 'Ada' })
    expect(await voterSignIn('b1', '2400001', 'Lovelace')).toEqual({ first_name: 'Ada' })
  })

  it('throws an ApiError carrying the status and the code', async () => {
    mockFetch(403, { error: 'not checked in', code: 'not_checked_in' })
    await expect(voterSignIn('b1', '2400001', 'Lovelace')).rejects.toMatchObject({
      status: 403, code: 'not_checked_in',
    })
  })

  it('still throws an ApiError when the body is not JSON', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('gateway timeout', { status: 504 })))
    const err = await voterSignIn('b1', '2400001', 'Lovelace').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ApiError)
    expect((err as ApiError).status).toBe(504)
  })

  it('reports a network failure as an ApiError with status 0', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch') }))
    const err = await submitBallot('b1', 'e1', ['a', 'b']).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ApiError)
    expect((err as ApiError).status).toBe(0)
  })

  it('never puts the usu_id in a ballot body — the session carries it', async () => {
    const spy = spyFetch(() => new Response(JSON.stringify({ receipt_token: 't' }), { status: 201 }))
    vi.stubGlobal('fetch', spy)
    await submitBallot('b1', 'e1', ['a', 'b'])
    expect(spy.mock.calls[0]![1]!.body).toBe(JSON.stringify({ preferences: ['a', 'b'] }))
  })

  it('encodes a slug that would otherwise break the path', async () => {
    const spy = spyFetch(() => new Response(JSON.stringify({}), { status: 200 }))
    vi.stubGlobal('fetch', spy)
    const { getBatchBySlug } = await import('../src/api.js')
    await getBatchBySlug('a/b')
    expect(spy.mock.calls[0]![0]).toContain('a%2Fb')
  })
})
