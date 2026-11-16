import { Hono } from 'hono'
import { z } from 'zod'
import type { Env } from '../index.js'
import { hashPassword } from '../auth/password.js'
import { timingSafeEqual } from '../auth/timing-safe-equal.js'
import { auditLogStatement, recordAudit } from '../db/audit.js'
import type { BatchRow } from '../db/types.js'
import { rateLimit, RATE_LIMITS } from '../middleware/rateLimit.js'

// Slugs that look like system paths. Nothing routes on them today.
const RESERVED_SLUGS = new Set([
  'new', 'api', 'admin', 'vote', 'voter', 'door', 'officer', 'official',
  'receipt', 'receipts', 'login', 'signin', 'sign-in', 'signup', 'sign-up',
  'health', 'static', 'assets',
])

// The slug is one URL path segment (vote.<domain>/<slug>). Reject, never normalise.
const slugSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, 'slug must be lowercase alphanumerics and hyphens only')
  .refine((slug) => !RESERVED_SLUGS.has(slug), { message: 'that name is reserved — please choose another' })

const accentColorSchema = z
  .string()
  .regex(/^#[0-9a-fA-F]{6}$/, 'accent_color must be a 6-digit hex colour, e.g. #2563eb')

// Allow-list: https://, root-relative, or '' for none. Rejects javascript:
// and data:.
const logoUrlSchema = z
  .string()
  .refine(
    (v) => v === '' || (v.startsWith('/') && v[1] !== '/' && v[1] !== '\\') || /^https:\/\//i.test(v),
    {
      message: 'logo_url must be empty, an https:// URL, or a root-relative path',
    },
  )

export const brandingSchema = z.object({
  title: z.string(),
  org_name: z.string(),
  accent_color: accentColorSchema,
  logo_url: logoUrlSchema,
})

/**
 * Low on purpose. PBKDF2 does not protect a six-character password if a hash
 * leaks. The defence is the sign-in rate limit.
 */
const PASSWORD_MIN = 6
const passwordSchema = (label: string) =>
  z.string().min(PASSWORD_MIN, `${label} must be at least ${PASSWORD_MIN} characters`)

const createBatchSchema = z
  .object({
    name: z.string().min(1),
    slug: slugSchema,
    officer_password: passwordSchema('officer_password'),
    door_password: passwordSchema('door_password'),
    branding: brandingSchema,
  })
  // The door password is typed on volunteers' phones. If it matched the officer
  // password, anyone at the desk could run the election.
  .refine((b) => b.officer_password !== b.door_password, {
    message: 'the door password must be different from the officer password',
    path: ['door_password'],
  })

type PublicBatch = { slug: string; name: string; branding: unknown }
type PublicBatchWithId = PublicBatch & { id: string }

const toPublic = (row: Pick<BatchRow, 'slug' | 'name' | 'branding'>): PublicBatch => ({
  slug: row.slug,
  name: row.name,
  branding: JSON.parse(row.branding) as unknown,
})

const enc = new TextEncoder()

/** Constant-time comparison against SUPER_ADMIN_KEY. */
function isSuperAdminKey(provided: string | undefined, expected: string): boolean {
  if (!provided) return false
  return timingSafeEqual(enc.encode(provided), enc.encode(expected))
}

const isUniqueSlugViolation = (err: unknown): boolean =>
  err instanceof Error && /UNIQUE constraint failed/i.test(err.message)

export const batches = new Hono<{ Bindings: Env }>()

// Rate limited first: a denied key attempt writes an audit row.
batches.post('/api/batches', rateLimit(RATE_LIMITS.batchCreate), async (c) => {
  // Sign-up needs no key. A wrong key is an attempt on the operator path:
  // refuse and audit it, without recording the key. A self-registered society
  // is unvetted, and neither frontend may imply otherwise.
  const provided = c.req.header('x-super-admin-key')
  if (provided !== undefined && !isSuperAdminKey(provided, c.env.SUPER_ADMIN_KEY)) {
    await recordAudit(c.env.DB, { batchId: null, role: 'super', action: 'batch.create.denied' })
    return c.json({ error: 'unauthorized' }, 401)
  }
  const byOperator = provided !== undefined

  const parsed = createBatchSchema.safeParse(await c.req.json().catch(() => undefined))
  if (!parsed.success) {
    return c.json({ error: 'invalid request body' }, 400)
  }
  const { name, slug, officer_password, door_password, branding } = parsed.data

  const id = crypto.randomUUID()
  const [officerHash, doorHash] = await Promise.all([hashPassword(officer_password), hashPassword(door_password)])

  // One transaction: the batch and its audit row are written together.
  try {
    await c.env.DB.batch([
      c.env.DB
        .prepare(
          `INSERT INTO batch (id, slug, name, officer_hash, door_hash, branding, created_at) VALUES (?,?,?,?,?,?,?)`,
        )
        .bind(id, slug, name, officerHash, doorHash, JSON.stringify(branding), Date.now()),
      auditLogStatement(c.env.DB, {
        batchId: id,
        role: byOperator ? 'super' : 'public',
        action: 'batch.create',
      }),
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

/**
 * Delete a society and everything in it. Operator only. Irreversible. The
 * only route that can remove a sealed election (LIMITATIONS.md §17).
 *
 * Gates, in order: the rate limit; `SUPER_ADMIN_KEY`, compared in constant
 * time (a failure is audited against a NULL batch, without the key); then
 * `confirm_slug` matching the society's slug.
 *
 * `audit_log` survives and records the deletion as counts only.
 */
batches.delete('/api/batches/:id', rateLimit(RATE_LIMITS.batchCreate), async (c) => {
  const provided = c.req.header('x-super-admin-key')
  if (!isSuperAdminKey(provided, c.env.SUPER_ADMIN_KEY)) {
    await recordAudit(c.env.DB, { batchId: null, role: 'super', action: 'batch.delete.denied' })
    return c.json({ error: 'unauthorized' }, 401)
  }

  const id = c.req.param('id') ?? ''
  const row = await c.env.DB
    .prepare(`SELECT id, slug FROM batch WHERE id = ?`)
    .bind(id)
    .first<Pick<BatchRow, 'id' | 'slug'>>()
  if (!row) return c.json({ error: 'not found' }, 404)

  const body = (await c.req.json().catch(() => undefined)) as { confirm_slug?: unknown } | undefined
  if (body?.confirm_slug !== row.slug) {
    return c.json(
      {
        error: 'confirm_slug must match the slug of the society being deleted',
        code: 'confirm_required',
      },
      409,
    )
  }

  const counts = await c.env.DB
    .prepare(
      `SELECT
         (SELECT count(*) FROM election WHERE batch_id = ?1) AS elections,
         (SELECT count(*) FROM ballot b JOIN election e ON e.id = b.election_id
           WHERE e.batch_id = ?1) AS ballots,
         (SELECT count(*) FROM voter_roll WHERE batch_id = ?1) AS voters`,
    )
    .bind(id)
    .first<{ elections: number; ballots: number; voters: number }>()

  // Every table is named, in dependency order: `election_seal` and
  // `election_result` do not cascade. One transaction.
  await c.env.DB.batch([
    c.env.DB.prepare(`DELETE FROM election_result WHERE election_id IN (SELECT id FROM election WHERE batch_id = ?)`).bind(id),
    c.env.DB.prepare(`DELETE FROM election_seal WHERE election_id IN (SELECT id FROM election WHERE batch_id = ?)`).bind(id),
    c.env.DB.prepare(`DELETE FROM ballot WHERE election_id IN (SELECT id FROM election WHERE batch_id = ?)`).bind(id),
    c.env.DB.prepare(`DELETE FROM vote_receipt WHERE election_id IN (SELECT id FROM election WHERE batch_id = ?)`).bind(id),
    c.env.DB.prepare(`DELETE FROM candidate WHERE election_id IN (SELECT id FROM election WHERE batch_id = ?)`).bind(id),
    c.env.DB.prepare(`DELETE FROM election WHERE batch_id = ?`).bind(id),
    c.env.DB.prepare(`DELETE FROM check_in WHERE batch_id = ?`).bind(id),
    c.env.DB.prepare(`DELETE FROM voter_roll WHERE batch_id = ?`).bind(id),
    c.env.DB.prepare(`DELETE FROM guest WHERE batch_id = ?`).bind(id),
    c.env.DB.prepare(`DELETE FROM batch WHERE id = ?`).bind(id),
    auditLogStatement(c.env.DB, {
      batchId: id,
      role: 'super',
      action: 'batch.delete',
      detail: {
        kind: 'batch_delete',
        elections: counts?.elections ?? 0,
        ballots: counts?.ballots ?? 0,
        voters: counts?.voters ?? 0,
      },
    }),
  ])

  await deleteLogos(c.env.LOGOS, id)

  return c.body(null, 204)
})

/**
 * Removes the society's logo objects after its rows. Never fatal: R2 shares
 * no transaction with D1, and an orphaned image is the lesser failure.
 */
async function deleteLogos(bucket: R2Bucket, batchId: string): Promise<void> {
  try {
    let cursor: string | undefined
    do {
      const listed = await bucket.list({ prefix: `batches/${batchId}/`, ...(cursor ? { cursor } : {}) })
      if (listed.objects.length > 0) await bucket.delete(listed.objects.map((o) => o.key))
      cursor = listed.truncated ? listed.cursor : undefined
    } while (cursor !== undefined)
  } catch {
    // The rows are gone. The society is deleted either way.
  }
}
