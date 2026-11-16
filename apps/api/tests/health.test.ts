import { describe, it, expect } from 'vitest'
import { SELF } from 'cloudflare:test'

describe('health', () => {
  it('reports ok', async () => {
    const res = await SELF.fetch('https://example.com/api/health')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ status: 'ok' })
  })

  it('404s an unknown route as JSON, not HTML', async () => {
    const res = await SELF.fetch('https://example.com/api/nope')
    expect(res.status).toBe(404)
    expect(res.headers.get('content-type')).toMatch(/application\/json/)
  })
})

describe('error contract', () => {
  it('answers JSON on an unhandled error, not text/plain', async () => {
    // A weak SESSION_SECRET makes sign-in throw. The frontend must be able to
    // res.json() the response. Hono's default handler returns text.
    const res = await SELF.fetch('https://example.com/api/batches/nope/officer/session', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: 'x' }),
    })
    expect(res.headers.get('content-type')).toMatch(/application\/json/)
    await expect(res.json()).resolves.toBeDefined()
  })
})
