import { Hono } from 'hono'
import { z } from 'zod'
import type { Env } from '../index.js'
import { hashPassword } from '../auth/password.js'
import { timingSafeEqual } from '../auth/timing-safe-equal.js'
import { auditLogStatement } from '../db/audit.js'
import type { BatchRow } from '../db/types.js'

// The voter-facing URL is vote.<domain>/<slug>: reject anything that would
// not survive being one URL path segment (e.g. containing `/` or `..`)
// rather than silently normalising it into something the officer did not
// choose and cannot predict.
const slugSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, 'slug must be lowercase alphanumerics and hyphens only')

const accentColorSchema = z
  .string()
  .regex(/^#[0-9a-fA-F]{6}$/, 'accent_color must be a 6-digit hex colour, e.g. #2563eb')

// Rendered by two frontends (Plan 3): only an https:// URL or a root-relative
// path is accepted, or '' for "no logo". This is an allow-list, so
// javascript: and data: schemes are rejected by construction, not by a
// denylist that the next scheme invents its way around.
const logoUrlSchema = z
  .string()
  .refine(
    (v) => v === '' || (v.startsWith('/') && v[1] !== '/' && v[1] !== '\\') || /^https:\/\//i.test(v),
    {
      message: 'logo_url must be empty, an https:// URL, or a root-relative path',
    },
  )

const brandingSchema = z.object({
  title: z.string(),
  org_name: z.string(),
  accent_color: accentColorSchema,
  logo_url: logoUrlSchema,
})

const createBatchSchema = z.object({
  name: z.string().min(1),
  slug: slugSchema,
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

  // Insert and audit row go through db.batch() as a single transaction —
  // the same mechanism spec §2 uses for the ballot/receipt pair — so a
  // failure never leaves a batch with no audit trail, or an audit entry for
  // a batch that was never actually created.
  try {
    await c.env.DB.batch([
      c.env.DB
        .prepare(
          `INSERT INTO batch (id, slug, name, officer_hash, door_hash, branding, created_at) VALUES (?,?,?,?,?,?,?)`,
        )
        .bind(id, slug, name, officerHash, doorHash, JSON.stringify(branding), Date.now()),
      auditLogStatement(c.env.DB, { batchId: id, role: 'super', action: 'batch.create' }),
    ])
  } catch (err) {
    if (isUniqueSlugViolation(err)) {
      return c.json({ error: 'slug already exists' }, 409)
    }
    throw err
  }

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
