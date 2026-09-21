/**
 * Editing a society's branding.
 *
 * The schema is imported from `routes/batches.ts` rather than restated, so the
 * provisioning path and the edit path cannot drift on what a valid accent
 * colour or logo URL is. That matters most for `logo_url`, which is an
 * allow-list: empty, an `https://` URL, or a root-relative path. A second copy
 * would be a second place for `javascript:` to become acceptable.
 *
 * PATCH replaces the whole branding object rather than merging field by field.
 * It is one small object that an officer edits as a whole in a form, and a merge
 * would let an omitted `accent_color` silently keep a value they thought they
 * had cleared.
 */
import { Hono } from 'hono'
import { brandingSchema } from './batches.js'
import { auditLogStatement } from '../db/audit.js'
import { requireRole, requireSession, type AuthedEnv } from '../middleware/requireRole.js'

export const branding = new Hono<AuthedEnv>()

branding.patch('/api/batches/:id/branding', requireRole('officer'), async (c) => {
  const batchId = requireSession(c).batchId

  const parsed = brandingSchema.safeParse(await c.req.json().catch(() => undefined))
  if (!parsed.success) {
    return c.json({ error: parsed.error.issues[0]?.message ?? 'invalid request body' }, 400)
  }

  await c.env.DB.batch([
    c.env.DB
      .prepare(`UPDATE batch SET branding = ? WHERE id = ?`)
      .bind(JSON.stringify(parsed.data), batchId),
    // No detail: branding is not sensitive, but an audit row carrying a whole
    // JSON object would be the first exception to "counts and reasons, not
    // payloads", and the next one would be a ballot.
    auditLogStatement(c.env.DB, { batchId, role: 'officer', action: 'branding.update' }),
  ])

  return c.json(parsed.data)
})
