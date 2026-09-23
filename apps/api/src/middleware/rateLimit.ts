/**
 * Fixed-window request counter in KV.
 *
 * **The sizing matters more than the mechanism.** An AGM is one room on one
 * wifi network, so every voter shares a source IP, and Australian mobile
 * carriers put CGNAT on top of that — one address can be thousands of people.
 * A tight per-IP limit therefore does not stop an attacker, it locks out the
 * room. Integrity for voting comes from the roll, the door check-in and the
 * `vote_receipt` primary key; never from a rate limit. These limits exist to
 * stop runaway billable CPU and to stop the audit trail being flooded until
 * real entries are unreadable — not to be a quota.
 *
 * The window is short on purpose: a stall that trips a limit recovers in ten
 * minutes rather than at the top of the hour.
 *
 * A fixed window can admit up to 2x the limit across a boundary, and the
 * read-then-write below can under-count under concurrency. Both are accepted
 * for the same reason: the numbers are cost ceilings, not guarantees.
 */
import type { Context, MiddlewareHandler } from 'hono'
import type { Env } from '../index.js'

export type RateLimitOptions = {
  /** Namespace, so exhausting one route's budget never exhausts another's. */
  name: string
  limit: number
  windowSeconds: number
}

export const RATE_LIMITS = {
  /** Operator-only, from anywhere. Tight is safe. */
  batchCreate: { name: 'batch-create', limit: 10, windowSeconds: 3600 },
  /**
   * Both staff sign-ins. ~100k PBKDF2 iterations *and* an audit row per
   * failure, on an unauthenticated route. Loose enough for a committee
   * retyping a shared password, tight enough that the audit trail cannot be
   * buried.
   */
  staffSignIn: { name: 'staff-signin', limit: 30, windowSeconds: 600 },
  /**
   * Roll lookup, voter sign-in, ballot submission. **Deliberately loose.** A
   * limit that blocks a queue of 200 people breaks the election; one that
   * lets them through cannot forge a ballot.
   */
  voting: { name: 'voting', limit: 300, windowSeconds: 600 },
} as const satisfies Record<string, RateLimitOptions>

/**
 * `cf-connecting-ip` is set by Cloudflare's edge and cannot be spoofed by a
 * caller. `x-forwarded-for` can be, so it is only a fallback for local
 * `wrangler dev` and tests; the first entry is the client.
 */
const clientIp = (c: Context): string =>
  c.req.header('cf-connecting-ip') ?? c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown'

export function rateLimit(opts: RateLimitOptions): MiddlewareHandler<{ Bindings: Env }> {
  return async (c, next) => {
    const nowSeconds = Math.floor(Date.now() / 1000)
    const window = Math.floor(nowSeconds / opts.windowSeconds)
    const key = `rl:${opts.name}:${window}:${clientIp(c)}`

    const current = Number((await c.env.RATE_LIMIT.get(key)) ?? '0')
    if (current >= opts.limit) {
      const resetAt = (window + 1) * opts.windowSeconds
      const retryAfter = Math.max(1, resetAt - nowSeconds)
      return c.json({ error: 'rate_limited', retry_after: retryAfter }, 429, {
        'retry-after': String(retryAfter),
      })
    }

    // Two windows of TTL so a key written at the very end of a window is
    // still readable for the whole of it. KV expiry is eventual, not exact.
    await c.env.RATE_LIMIT.put(key, String(current + 1), { expirationTtl: opts.windowSeconds * 2 })

    await next()
  }
}
