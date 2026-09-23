import { Hono } from 'hono'
import { z } from 'zod'
import type { Env } from '../index.js'
import { hashPassword } from '../auth/password.js'
import { timingSafeEqual } from '../auth/timing-safe-equal.js'
import { auditLogStatement, recordAudit } from '../db/audit.js'
import type { BatchRow } from '../db/types.js'
import { rateLimit, RATE_LIMITS } from '../middleware/rateLimit.js'

// The voter-facing URL is vote.<domain>/<slug>: reject anything that would
// not survive being one URL path segment (e.g. containing `/` or `..`)
// rather than silently normalising it into something the officer did not
// choose and cannot predict.
/**
 * Slugs a society may not take. The slug goes in a URL — `vote.<domain>/<slug>`
 * — so these are the words that would read as part of the system rather than as
 * a society, plus the paths either app might plausibly add at the top level.
 *
 * Note this is not a routing requirement: admin slugs live under `/b/:slug` and
 * the voter app has no top-level siblings, so nothing here prevents a collision
 * today. It prevents a society calling itself `admin` or `official`.
 */
const RESERVED_SLUGS = new Set([
  'new', 'api', 'admin', 'vote', 'voter', 'door', 'officer', 'official',
  'receipt', 'receipts', 'login', 'signin', 'sign-in', 'signup', 'sign-up',
  'health', 'static', 'assets',
])

const slugSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, 'slug must be lowercase alphanumerics and hyphens only')
  .refine((slug) => !RESERVED_SLUGS.has(slug), { message: 'that name is reserved — please choose another' })

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

export const brandingSchema = z.object({
  title: z.string(),
  org_name: z.string(),
  accent_color: accentColorSchema,
  logo_url: logoUrlSchema,
})

/**
 * Lowered from 12 to 6 on 2026-09-22 at the user's direction.
 *
 * PBKDF2 at 100k iterations (the Workers ceiling) is the only thing in front of these, and it slows an
 * attacker by a constant factor — it does not rescue a short password. At six
 * characters a lowercase-and-digits password is about 2 billion combinations,
 * which is within reach of an offline attack on commodity hardware if a hash is
 * ever exposed, so the practical defence is now the sign-in rate limit
 * (30 per 10 minutes per IP) rather than the password itself.
 *
 * The floor still lives at provisioning time, where the password is chosen,
 * rather than at sign-in where it would be too late.
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
  // The door password is typed on volunteers' phones and grants check-in only.
  // Reusing the officer password there hands full control of every election to
  // anyone at the desk, which is the one privilege boundary this system has.
  // Enforced here rather than only in the signup form, which curl bypasses.
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

/** Constant-time comparison against the operator's SUPER_ADMIN_KEY secret. */
function isSuperAdminKey(provided: string | undefined, expected: string): boolean {
  if (!provided) return false
  return timingSafeEqual(enc.encode(provided), enc.encode(expected))
}

const isUniqueSlugViolation = (err: unknown): boolean =>
  err instanceof Error && /UNIQUE constraint failed/i.test(err.message)

export const batches = new Hono<{ Bindings: Env }>()

// Limited before anything else runs. Plan 2a made a *denied* attempt write an
// audit row -- deliberately, since this is the descendant of the legacy
// unauthenticated tenant-creation hole -- which turned a zero-work 401 into an
// unauthenticated D1 write. The row is entirely attacker-uncontrolled, but it
// was unbounded.
batches.post('/api/batches', rateLimit(RATE_LIMITS.batchCreate), async (c) => {
  /**
   * Societies sign themselves up, so no key is required.
   *
   * The key is still honoured when one is *offered*: presenting a wrong one is
   * somebody probing the operator path, which is worth refusing and recording
   * even though omitting it entirely would have been allowed. Omitting it is a
   * signup; getting it wrong is an attempt.
   *
   * `detail` records nothing about the supplied key — not the value, not a
   * prefix, not a length. A near-miss guess in the audit trail is a credential
   * sitting in a table officers and exports can read.
   *
   * With no key, nothing verifies that a society is who it says it is. The
   * system sends no email, so it cannot. Nothing in either frontend may imply a
   * self-registered society is vetted.
   */
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
 * Delete a society and everything in it. **Operator only, and irreversible.**
 *
 * This is the most destructive route in the system, and the only one that can
 * remove a sealed election. `election_seal` and `election_result` were given no
 * `ON DELETE CASCADE` (spec §2) so that nothing *incidental* could ever take a
 * sealed result with it; deleting them here is deliberate and explicit, which is
 * the distinction that matters. An officer password cannot reach this — see
 * `DELETE /elections/:eid`, which refuses the moment a ballot exists.
 *
 * Three things stand in front of it:
 *
 * 1. `SUPER_ADMIN_KEY`, compared in constant time. A wrong or missing key is
 *    recorded as `batch.delete.denied` with a NULL `batch_id`, the same way a
 *    denied create is — this is the one route where a *successful* guess is
 *    unrecoverable, so an attempt is worth seeing. The key itself is never
 *    recorded, not even a length.
 * 2. `confirm_slug` in the body must equal the society's own slug. The id is a
 *    UUID nobody types from memory, so without this the difference between
 *    deleting the right society and the wrong one is a copy-paste.
 * 3. The rate limit runs before either, so an unauthenticated caller cannot use
 *    the audit write as an amplifier.
 *
 * What survives: `audit_log`. It has no foreign key to `batch` precisely so that
 * it does not cascade away with its subject, and the deletion is recorded there
 * as counts — how many elections, ballots and roll entries were destroyed —
 * never a name, a slug or a usu_id.
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

  // Every table is named explicitly, in dependency order, rather than leaning on
  // `ON DELETE CASCADE`. Two reasons: the cascade does not cover `election_seal`
  // or `election_result` at all, and a destructive operation should say what it
  // destroys where a reader can check the list against the schema. One
  // transaction, so a failure half way leaves the society intact.
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
 * The society's logo objects, after its rows are gone.
 *
 * Deliberately after, and deliberately not fatal. R2 is a separate store with no
 * transaction shared with D1, so one of the two has to go second; leaving an
 * orphaned image in a bucket is a far better failure than a half-deleted society
 * whose rows are gone and whose delete reported an error. Keys are content
 * hashes under `batches/<id>/`, so nothing outside this society is in the prefix.
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
    // The rows are already gone; the society is deleted either way.
  }
}
