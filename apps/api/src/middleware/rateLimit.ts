/**
 * Per-IP request limits on Cloudflare's Workers Rate Limiting binding.
 *
 * The limits are loose. An AGM is one room on one wifi network, and mobile
 * carriers use CGNAT, so a tight per-IP limit locks out the room. Integrity
 * comes from the roll, the door check-in and the `vote_receipt` primary key.
 * These limits cap billable CPU and audit-log volume.
 *
 * The numbers are in wrangler.jsonc. The binding's counters are per location
 * and eventually consistent, so it can admit slightly more than the limit.
 *
 * Not KV: a counter there uses the free plan's 1,000 writes a day, after
 * which every limited route returns 500.
 *
 * Fails open. A limiter outage must not stop the election.
 */
import type { Context, MiddlewareHandler } from 'hono'
import type { Env } from '../index.js'

/**
 * One binding per budget, so routes do not share a limit (per minute per IP):
 * - BATCH_CREATE_LIMITER: society sign-up and operator delete. 3.
 * - STAFF_SIGNIN_LIMITER: both staff sign-ins. 10. A failure costs a PBKDF2
 *   run and an audit row.
 * - VOTING_LIMITER: roll lookup, voter sign-in, ballots, receipts. 600: a
 *   whole room may submit in the same minute.
 */
type LimiterBinding = 'BATCH_CREATE_LIMITER' | 'STAFF_SIGNIN_LIMITER' | 'VOTING_LIMITER'

/** Every binding's period in wrangler.jsonc. Returned as Retry-After. */
const PERIOD_SECONDS = 60

/**
 * Cloudflare's edge sets `cf-connecting-ip`; clients cannot spoof it.
 * `x-forwarded-for` is a fallback for `wrangler dev` and tests.
 */
const clientIp = (c: Context): string =>
  c.req.header('cf-connecting-ip') ?? c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown'

export function rateLimit(binding: LimiterBinding): MiddlewareHandler<{ Bindings: Env }> {
  return async (c, next) => {
    let allowed = true
    try {
      allowed = (await c.env[binding].limit({ key: clientIp(c) })).success
    } catch (err) {
      console.error('rate limiter unavailable; allowing request', binding, err)
    }

    if (!allowed) {
      return c.json({ error: 'rate_limited' }, 429, { 'retry-after': String(PERIOD_SECONDS) })
    }

    await next()
  }
}
