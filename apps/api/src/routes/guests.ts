/**
 * Guests: people in the room who are not on the roll, recorded for the
 * head-count and the minutes.
 *
 * A guest cannot vote: `guest` has no `usu_id`, so the eligibility clause in
 * ballots.ts cannot match. Never add one, and never move a guest into
 * `voter_roll`. A member the export missed goes through doorVoters.ts.
 */
import { Hono } from 'hono'
import { z } from 'zod'
import { auditLogStatement, recordAudit } from '../db/audit.js'
import { requireRole, requireSession, type AuthedEnv } from '../middleware/requireRole.js'
import { rateLimit, RATE_LIMITS } from '../middleware/rateLimit.js'
import { pathParam } from '../http/params.js'
import type { GuestRow } from '../db/types.js'

const guestSchema = z.object({
  // Trimmed first, so "   " is missing.
  name: z.string().trim().min(1).max(200),
  note: z.string().trim().max(500).optional(),
})

export const guests = new Hono<AuthedEnv>()

guests.post(
  '/api/batches/:id/guests',
  requireRole('door'),
  rateLimit(RATE_LIMITS.voting),
  async (c) => {
    const batchId = requireSession(c).batchId
    const parsed = guestSchema.safeParse(await c.req.json().catch(() => undefined))
    if (!parsed.success) return c.json({ error: 'invalid request body' }, 400)

    const id = crypto.randomUUID()
    await c.env.DB.batch([
      c.env.DB
        .prepare(`INSERT INTO guest (id, batch_id, name, note, checked_in_at) VALUES (?,?,?,?,?)`)
        .bind(id, batchId, parsed.data.name, parsed.data.note ?? null, Date.now()),
      auditLogStatement(c.env.DB, { batchId, role: 'door', action: 'guest.add' }),
    ])

    return c.json({ id, name: parsed.data.name }, 201)
  },
)

guests.get('/api/batches/:id/guests', requireRole('door'), async (c) => {
  const batchId = requireSession(c).batchId
  const { results } = await c.env.DB
    .prepare(`SELECT id, name, note, checked_in_at FROM guest WHERE batch_id = ? ORDER BY checked_in_at`)
    .bind(batchId)
    .all<Pick<GuestRow, 'id' | 'name' | 'note' | 'checked_in_at'>>()
  return c.json(results)
})

/** Idempotent, like un-check-in, so a volunteer can undo a tap. */
guests.delete('/api/batches/:id/guests/:guestId', requireRole('door'), async (c) => {
  const batchId = requireSession(c).batchId
  const guestId = pathParam(c, 'guestId')

  const result = await c.env.DB
    .prepare(`DELETE FROM guest WHERE id = ? AND batch_id = ?`)
    .bind(guestId, batchId)
    .run()

  if (result.meta.changes > 0) {
    await recordAudit(c.env.DB, { batchId, role: 'door', action: 'guest.remove' })
  }
  return c.body(null, 204)
})
