/**
 * Per-IP request limits, on Cloudflare's Workers Rate Limiting binding.
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
 * **Why not KV (2026-09-24).** This was a counter in KV, written on every
 * request. The free plan allows 1,000 KV writes a day, and when they ran out
 * `put()` threw, so every limited route — staff sign-in, voter sign-in, ballot
 * submission — returned 500 until midnight UTC. One AGM would spend the quota
 * on its own. KV also allows one write per second per key, and a room behind
 * one IP is exactly one key. The binding has neither limit, and costs nothing.
 *
 * **The numbers live in wrangler.jsonc**, one binding per budget, because the
 * binding enforces them; `RATE_LIMITS` only names which binding a route uses.
 * The binding supports a 10 or 60 second period and nothing longer. Its
 * counters are per Cloudflare location and eventually consistent, so it can
 * admit somewhat more than the limit — accepted for the same reason as above.
 *
 * **It fails open.** If the binding itself throws, the request proceeds and
 * the error is logged. A limiter outage must never take the election down
 * with it; that is precisely what the KV version did.
 */
import type { Context, MiddlewareHandler } from 'hono'
import type { Env } from '../index.js'

type LimiterBinding = 'BATCH_CREATE_LIMITER' | 'STAFF_SIGNIN_LIMITER' | 'VOTING_LIMITER'

export type RateLimitOptions = {
  /** Which binding, so exhausting one route's budget never exhausts another's. */
  binding: LimiterBinding
  /** The binding's period, sent back as Retry-After. Must match wrangler.jsonc. */
  periodSeconds: 10 | 60
}

export const RATE_LIMITS = {
  /** Society sign-up and operator delete. 3 per minute per IP. */
  batchCreate: { binding: 'BATCH_CREATE_LIMITER', periodSeconds: 60 },
  /**
   * Both staff sign-ins, 10 per minute per IP. ~100k PBKDF2 iterations *and*
   * an audit row per failure, on an unauthenticated route. Loose enough for a
   * committee retyping a shared password, tight enough that the audit trail
   * cannot be buried.
   */
  staffSignIn: { binding: 'STAFF_SIGNIN_LIMITER', periodSeconds: 60 },
  /**
   * Roll lookup, voter sign-in, ballot submission, receipts: 600 per minute
   * per IP. **Deliberately loose.** A whole room submitting within the same
   * minute is the expected case, not an attack. A limit that blocks the queue
   * breaks the election; one that lets them through cannot forge a ballot.
   */
  voting: { binding: 'VOTING_LIMITER', periodSeconds: 60 },
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
