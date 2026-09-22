import type { Context } from 'hono'

/**
 * The deployment is missing a secret it cannot work without.
 *
 * 503, not 500: this is configuration, not a bug, and an operator reading a log
 * should be able to tell those apart instantly. It names nothing — not which
 * value, not its length, not its prefix — because a caller has no business
 * knowing, and the operator finds the detail in the Worker's log.
 *
 * Previously these sites threw, which `app.onError` turned into an opaque
 * `{error:'internal'}` 500 while the comments beside them claimed the response
 * said "this server is not configured". It now does.
 */
export const notConfigured = (c: Context): Response =>
  c.json({ error: 'server_not_configured' }, 503)
