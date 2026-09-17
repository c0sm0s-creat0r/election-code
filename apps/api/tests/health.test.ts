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
