import { describe, it, expect } from 'vitest'
import { Hono } from 'hono'
import wranglerConfig from '../wrangler.jsonc?raw'
import type { Env } from '../src/index.js'
import { rateLimit, RATE_LIMITS } from '../src/middleware/rateLimit.js'

/**
 * A fake binding: the real one's counters cannot be reset between tests.
 * This tests the middleware. The numbers are checked against wrangler.jsonc
 * below.
 */
function fakeLimiter(limit: number) {
  const counts = new Map<string, number>()
  const keys: string[] = []
  const binding = {
    limit: async ({ key }: { key: string }) => {
      keys.push(key)
      const n = (counts.get(key) ?? 0) + 1
      counts.set(key, n)
      return { success: n <= limit }
    },
  }
  return { binding: binding as unknown as RateLimit, keys }
}

function appWith(env: Partial<Env>) {
  let handled = 0
  const app = new Hono<{ Bindings: Env }>()
  app.post('/x', rateLimit(RATE_LIMITS.staffSignIn), (c) => {
    handled++
    return c.json({ ok: true })
  })
  const hit = (ip = '203.0.113.1') =>
    app.request('/x', { method: 'POST', headers: { 'cf-connecting-ip': ip } }, env as Env)
  return { hit, handled: () => handled }
}

describe('rate limiting', () => {
  it('allows requests under the limit', async () => {
    const { hit } = appWith({ STAFF_SIGNIN_LIMITER: fakeLimiter(2).binding })
    expect((await hit()).status).toBe(200)
    expect((await hit()).status).toBe(200)
  })

  it('returns 429 with Retry-After once the limit is exceeded, without running the handler', async () => {
    const { hit, handled } = appWith({ STAFF_SIGNIN_LIMITER: fakeLimiter(1).binding })
    await hit()
    const res = await hit()
    expect(res.status).toBe(429)
    expect(await res.json()).toMatchObject({ error: 'rate_limited', retry_after: 60 })
    expect(res.headers.get('retry-after')).toBe('60')
    // A 429 on sign-in runs no PBKDF2 and writes no audit row.
    expect(handled()).toBe(1)
  })

  it('counts per IP, so one blocked client does not block another', async () => {
    const { hit } = appWith({ STAFF_SIGNIN_LIMITER: fakeLimiter(1).binding })
    await hit('203.0.113.1')
    expect((await hit('203.0.113.1')).status).toBe(429)
    expect((await hit('198.51.100.7')).status).toBe(200)
  })

  it('falls back to x-forwarded-for when cf-connecting-ip is absent', async () => {
    const { binding, keys } = fakeLimiter(10)
    const app = new Hono<{ Bindings: Env }>()
    app.post('/x', rateLimit(RATE_LIMITS.staffSignIn), (c) => c.json({ ok: true }))
    await app.request('/x', { method: 'POST', headers: { 'x-forwarded-for': '192.0.2.5, 70.41.3.18' } },
      { STAFF_SIGNIN_LIMITER: binding } as Env)
    expect(keys).toEqual(['192.0.2.5'])
  })

  // A limiter outage must not stop voting.
  it('fails open when the limiter itself throws', async () => {
    const broken = { limit: async () => { throw new Error('limiter down') } } as unknown as RateLimit
    const { hit, handled } = appWith({ STAFF_SIGNIN_LIMITER: broken })
    expect((await hit()).status).toBe(200)
    expect(handled()).toBe(1)
  })

  it('gives each budget its own binding, so exhausting one never exhausts another', () => {
    const bindings = Object.values(RATE_LIMITS).map((l) => l.binding)
    expect(new Set(bindings).size).toBe(bindings.length)
  })

  it('declares every binding in wrangler.jsonc with the period RATE_LIMITS reports', () => {
    for (const { binding, periodSeconds } of Object.values(RATE_LIMITS)) {
      const line = wranglerConfig.split('\n').find((l) => l.includes(`"name": "${binding}"`))
      expect(line, binding).toBeDefined()
      expect(line).toContain(`"period": ${periodSeconds}`)
    }
  })

  it('keeps the voting budget loose enough for a full room on one IP', () => {
    const line = wranglerConfig.split('\n').find((l) => l.includes('"name": "VOTING_LIMITER"'))!
    expect(Number(/"limit": (\d+)/.exec(line)![1])).toBeGreaterThanOrEqual(600)
  })
})
