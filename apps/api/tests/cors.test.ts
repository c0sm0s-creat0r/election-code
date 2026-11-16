import { describe, it, expect } from 'vitest'
import { SELF } from 'cloudflare:test'

// Must match vitest.config.ts's ALLOWED_ORIGINS binding.
const ALLOWED = 'https://admin.dalyell.com.au'
const ALLOWED_2 = 'https://vote.dalyell.com.au'

const get = (origin?: string) =>
  SELF.fetch('https://example.com/api/health', origin ? { headers: { origin } } : {})

const preflight = (origin: string, method = 'POST') =>
  SELF.fetch('https://example.com/api/batches', {
    method: 'OPTIONS',
    headers: {
      origin,
      'access-control-request-method': method,
      'access-control-request-headers': 'content-type',
    },
  })

describe('CORS', () => {
  it('echoes an allow-listed origin exactly, with credentials enabled', async () => {
    const res = await get(ALLOWED)
    expect(res.headers.get('access-control-allow-origin')).toBe(ALLOWED)
    expect(res.headers.get('access-control-allow-credentials')).toBe('true')
  })

  it('allows every configured origin, not just the first', async () => {
    expect((await get(ALLOWED_2)).headers.get('access-control-allow-origin')).toBe(ALLOWED_2)
  })

  it('sends NO Access-Control-Allow-Origin at all for an unlisted origin', async () => {
    // The header is absent, which is what makes the browser refuse.
    const res = await get('https://evil.example')
    expect(res.headers.get('access-control-allow-origin')).toBeNull()
  })

  it('never emits `*`, under any input', async () => {
    const inputs = [
      undefined,
      '',
      '*',
      'null',
      'https://evil.example',
      `${ALLOWED}.evil.example`,
      `${ALLOWED}/`,
      `http://admin.dalyell.com.au`,
      `HTTPS://ADMIN.DALYELL.COM.AU`,
      `https://admin.dalyell.com.au:8443`,
    ]
    for (const origin of inputs) {
      const res = await get(origin)
      expect(res.headers.get('access-control-allow-origin')).not.toBe('*')
      if (origin !== ALLOWED) {
        expect(res.headers.get('access-control-allow-origin')).toBeNull()
      }
    }
  })

  it('rejects a prefix/suffix near-miss rather than matching loosely', async () => {
    for (const origin of ['https://dalyell.com.au', 'https://evil-admin.dalyell.com.au']) {
      expect((await get(origin)).headers.get('access-control-allow-origin')).toBeNull()
    }
  })

  it('answers a preflight from an allow-listed origin', async () => {
    const res = await preflight(ALLOWED)
    expect(res.status).toBe(204)
    expect(res.headers.get('access-control-allow-origin')).toBe(ALLOWED)
    expect(res.headers.get('access-control-allow-credentials')).toBe('true')
    expect(res.headers.get('access-control-allow-methods') ?? '').toContain('DELETE')
  })

  it('does not authorise a preflight from an unlisted origin', async () => {
    const res = await preflight('https://evil.example')
    expect(res.headers.get('access-control-allow-origin')).toBeNull()
  })

  it('varies on Origin so a cached response is not served to another site', async () => {
    expect((await get(ALLOWED)).headers.get('vary') ?? '').toContain('Origin')
  })

  it('still serves the route itself — CORS gates the browser, not the API', async () => {
    // A non-browser caller sends no Origin and is unaffected: CORS is not
    // authentication.
    const res = await get()
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ status: 'ok' })
  })
})
