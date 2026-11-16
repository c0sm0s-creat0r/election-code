/**
 * Editing a society's branding. The schema is shared with batches.ts, so the
 * `logo_url` allow-list is in one place.
 *
 * PATCH replaces the whole object. A merge would keep a field the officer
 * meant to clear.
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
    // No payload in the audit row.
    auditLogStatement(c.env.DB, { batchId, role: 'officer', action: 'branding.update' }),
  ])

  return c.json(parsed.data)
})
