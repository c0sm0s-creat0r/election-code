import type { Context } from 'hono'

/**
 * The deployment is missing a secret. 503, not 500: configuration, not a bug.
 * The response does not name the secret.
 */
export const notConfigured = (c: Context): Response =>
  c.json({ error: 'server_not_configured' }, 503)
