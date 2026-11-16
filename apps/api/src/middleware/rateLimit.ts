/**
 * Per-IP request limits on Cloudflare's Workers Rate Limiting binding.
 *
 * The limits are loose. An AGM is one room on one wifi network, and mobile
 * carriers use CGNAT, so a tight per-IP limit locks out the room. Integrity
 * comes from the roll, the door check-in and the `vote_receipt` primary key.
 * These limits cap billable CPU and audit-log volume.
 *
 * The numbers are in wrangler.jsonc, one binding per budget. The binding
 * supports a 10 or 60 second period only. Its counters are per location and
 * eventually consistent, so it can admit slightly more than the limit.
 *
 * Not KV: a counter there uses the free plan's 1,000 writes a day, after
 * which every limited route returns 500.
 *
 * Fails open. A limiter outage must not stop the election.
 */
import type { Context, MiddlewareHandler } from 'hono'
import type { Env } from '../index.js'

type LimiterBinding = 'BATCH_CREATE_LIMITER' | 'STAFF_SIGNIN_LIMITER' | 'VOTING_LIMITER'

export type RateLimitOptions = {
  /** One binding per budget, so routes do not share a limit. */
  binding: LimiterBinding
  /** The binding's period, returned as Retry-After. Must match wrangler.jsonc. */
  periodSeconds: 10 | 60
}

export const RATE_LIMITS = {
  /** Society sign-up and operator delete. 3 per minute per IP. */
  batchCreate: { binding: 'BATCH_CREATE_LIMITER', periodSeconds: 60 },
  /** Both staff sign-ins. 10 per minute per IP. A failure costs a PBKDF2 run and an audit row. */
  staffSignIn: { binding: 'STAFF_SIGNIN_LIMITER', periodSeconds: 60 },
  /**
   * Roll lookup, voter sign-in, ballot submission, receipts. 600 per minute
   * per IP: a whole room may submit in the same minute.
   */
  voting: { binding: 'VOTING_LIMITER', periodSeconds: 60 },
} as const satisfies Record<string, RateLimitOptions>

/**
 * Cloudflare's edge sets `cf-connecting-ip`; clients cannot spoof it.
 * `x-forwarded-for` is a fallback for `wrangler dev` and tests.
 */
const clientIp = (c: Context): string =>
  c.req.header('cf-connecting-ip') ?? c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown'

export function rateLimit(opts: RateLimitOptions): MiddlewareHandler<{ Bindings: Env }> {
  return async (c, next) => {
    let allowed = true
    try {
      allowed = (await c.env[opts.binding].limit({ key: clientIp(c) })).success
    } catch (err) {
      console.error('rate limiter unavailable; allowing request', opts.binding, err)
    }

    if (!allowed) {
      const retryAfter = opts.periodSeconds
      return c.json({ error: 'rate_limited', retry_after: retryAfter }, 429, {
        'retry-after': String(retryAfter),
      })
    }

    await next()
  }
}
