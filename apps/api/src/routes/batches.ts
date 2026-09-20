import { Hono } from 'hono'
import { z } from 'zod'
import type { Env } from '../index.js'
import { hashPassword } from '../auth/password.js'
import { timingSafeEqual } from '../auth/timing-safe-equal.js'
import { recordAudit } from '../db/audit.js'
import type { BatchRow } from '../db/types.js'

const brandingSchema = z.object({
  title: z.string(),
  org_name: z.string(),
  accent_color: z.string(),
  logo_url: z.string(),
})

const createBatchSchema = z.object({
  name: z.string().min(1),
  slug: z.string().min(1),
  officer_password: z.string().min(1),
  door_password: z.string().min(1),
  branding: brandingSchema,
})

type PublicBatch = { slug: string; name: string; branding: unknown }
type PublicBatchWithId = PublicBatch & { id: string }

const toPublic = (row: Pick<BatchRow, 'slug' | 'name' | 'branding'>): PublicBatch => ({
  slug: row.slug,
  name: row.name,
  branding: JSON.parse(row.branding) as unknown,
})

const enc = new TextEncoder()

/** Constant-time comparison against the operator's SUPER_ADMIN_KEY secret. */
function isSuperAdminKey(provided: string | undefined, expected: string): boolean {
  if (!provided) return false
  return timingSafeEqual(enc.encode(provided), enc.encode(expected))
}

const isUniqueSlugViolation = (err: unknown): boolean =>
  err instanceof Error && /UNIQUE constraint failed/i.test(err.message)

export const batches = new Hono<{ Bindings: Env }>()

batches.post('/api/batches', async (c) => {
  // The super-admin key is checked before the body is read at all: an
  // unauthorised caller should not be able to probe validation behaviour.
  const provided = c.req.header('x-super-admin-key')
  if (!isSuperAdminKey(provided, c.env.SUPER_ADMIN_KEY)) {
    return c.json({ error: 'unauthorized' }, 401)
  }

  const parsed = createBatchSchema.safeParse(await c.req.json().catch(() => undefined))
  if (!parsed.success) {
    return c.json({ error: 'invalid request body' }, 400)
  }
  const { name, slug, officer_password, door_password, branding } = parsed.data

  const id = crypto.randomUUID()
  const [officerHash, doorHash] = await Promise.all([hashPassword(officer_password), hashPassword(door_password)])

  try {
    await c.env.DB.prepare(
      `INSERT INTO batch (id, slug, name, officer_hash, door_hash, branding, created_at) VALUES (?,?,?,?,?,?,?)`,
    )
      .bind(id, slug, name, officerHash, doorHash, JSON.stringify(branding), Date.now())
      .run()
  } catch (err) {
    if (isUniqueSlugViolation(err)) {
      return c.json({ error: 'slug already exists' }, 409)
    }
    throw err
  }

  await recordAudit(c.env.DB, { batchId: id, role: 'super', action: 'batch.create' })

  return c.json({ id, slug, name, branding }, 201)
})

batches.get('/api/batches', async (c) => {
  const { results } = await c.env.DB.prepare(`SELECT slug, name, branding FROM batch`).all<
    Pick<BatchRow, 'slug' | 'name' | 'branding'>
  >()
  return c.json(results.map(toPublic))
})

batches.get('/api/batches/by-slug/:slug', async (c) => {
  const slug = c.req.param('slug')
  const row = await c.env.DB.prepare(`SELECT id, slug, name, branding FROM batch WHERE slug = ?`)
    .bind(slug)
    .first<Pick<BatchRow, 'id' | 'slug' | 'name' | 'branding'>>()
  if (!row) return c.json({ error: 'not found' }, 404)
  const result: PublicBatchWithId = { id: row.id, ...toPublic(row) }
  return c.json(result)
})
