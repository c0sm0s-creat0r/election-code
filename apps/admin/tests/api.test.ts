import { describe, it, expect, vi, afterEach } from 'vitest'
import { ApiError, officerSignIn, doorSignIn } from '../src/api.js'

afterEach(() => vi.unstubAllGlobals())

const spyFetch = (respond: () => Response) =>
  vi.fn(async (_url: string, _init?: RequestInit) => respond())

describe('admin api client', () => {
  it('sends credentials, or the session cookie never travels', async () => {
    const spy = spyFetch(() => new Response(JSON.stringify({ ok: true }), { status: 200 }))
    vi.stubGlobal('fetch', spy)
    await officerSignIn('b1', 'pw')
    expect(spy.mock.calls[0]![1]).toMatchObject({ credentials: 'include' })
  })

  it('throws an ApiError carrying the status and the code', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ error: 'forbidden', code: 'wrong_role' }),
      { status: 403, headers: { 'content-type': 'application/json' } },
    )))
    await expect(doorSignIn('b1', 'pw')).rejects.toMatchObject({ status: 403, code: 'wrong_role' })
  })

  it('reports a network failure as status 0', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch') }))
    const err = await officerSignIn('b1', 'pw').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ApiError)
    expect((err as ApiError).status).toBe(0)
  })

  it('keeps the status when the body is not JSON', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('bad gateway', { status: 502 })))
    const err = await officerSignIn('b1', 'pw').catch((e: unknown) => e)
    expect((err as ApiError).status).toBe(502)
  })
})
