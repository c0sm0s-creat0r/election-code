import { describe, it, expect } from 'vitest'
import { api } from './helpers.js'

// Must match the vitest config's ALLOWED_ORIGINS binding.
const ALLOWED = ['https://admin.dalyell.com.au', 'https://vote.dalyell.com.au']

const get = (origin: string) => api('GET', '/health', '', undefined, { origin })

const preflight = (origin: string) =>
  api('OPTIONS', '/batches', '', undefined, {
    origin, 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type',
  })

describe('CORS', () => {
  it('echoes each allow-listed origin exactly, with credentials, varying on Origin', async () => {
    for (const origin of ALLOWED) {
      const res = await get(origin)
      expect(res.headers.get('access-control-allow-origin')).toBe(origin)
      expect(res.headers.get('access-control-allow-credentials')).toBe('true')
      // so a cached response is not served to another site
      expect(res.headers.get('vary') ?? '').toContain('Origin')
    }
  })

  it('sends NO Access-Control-Allow-Origin for anything but an exact match: never `*`', async () => {
    // The header is absent, which is what makes the browser refuse.
    for (const origin of [
      '', '*', 'null', 'https://evil.example',
      `${ALLOWED[0]}.evil.example`, `${ALLOWED[0]}/`, `${ALLOWED[0]}:8443`,
      'http://admin.dalyell.com.au', 'HTTPS://ADMIN.DALYELL.COM.AU',
      'https://dalyell.com.au', 'https://evil-admin.dalyell.com.au',
    ]) {
      expect((await get(origin)).headers.get('access-control-allow-origin'), origin).toBeNull()
    }
  })

  it('answers a preflight from an allow-listed origin', async () => {
    const res = await preflight(ALLOWED[0]!)
    expect(res.status).toBe(204)
    expect(res.headers.get('access-control-allow-origin')).toBe(ALLOWED[0])
    expect(res.headers.get('access-control-allow-credentials')).toBe('true')
    expect(res.headers.get('access-control-allow-methods') ?? '').toContain('DELETE')
  })

  it('does not authorise a preflight from an unlisted origin', async () => {
    expect((await preflight('https://evil.example')).headers.get('access-control-allow-origin')).toBeNull()
  })
})
