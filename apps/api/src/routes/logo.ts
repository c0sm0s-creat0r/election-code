/**
 * Society logo upload and delivery.
 *
 * **Three legacy holes close here**, all recorded in spec §6:
 *
 * 1. `POST /batches/<id>/logo` had **no auth decorator at all**, so anyone on
 *    the internet could replace any society's logo. Officer session required.
 * 2. It validated by file extension, which the uploader chooses. Now the magic
 *    bytes decide, and the stored content type comes from them — never from the
 *    request, and never from the filename.
 * 3. It wrote to Render's ephemeral disk, so logos vanished on the next restart.
 *    Now R2.
 *
 * **Keys are content hashes**, `batches/<batchId>/<sha256>.<ext>`. The legacy
 * `secure_filename` collapsed every society's `logo.png` onto one path, so one
 * upload overwrote another's; hashing removes the collision entirely and makes
 * re-uploading the same file idempotent. The batch prefix keeps one society's
 * objects out of another's namespace even so.
 */
import { Hono } from 'hono'
import { auditLogStatement } from '../db/audit.js'
import { requireRole, requireSession, type AuthedEnv } from '../middleware/requireRole.js'
import { pathParam } from '../http/params.js'
import { detectImageType } from '../lib/imageType.js'
import type { BatchRow } from '../db/types.js'
import type { Env } from '../index.js'

/** A logo on a ballot page. The real one in use is ~40 KB. */
const MAX_LOGO_BYTES = 2 * 1024 * 1024

/**
 * A year, immutable. Safe because the key is a hash of the content: different
 * bytes are a different URL, so a cached response can never be stale.
 */
const CACHE_CONTROL = 'public, max-age=31536000, immutable'

export const logo = new Hono<AuthedEnv>()

logo.post('/api/batches/:id/logo', requireRole('officer'), async (c) => {
  const batchId = requireSession(c).batchId

  const form = await c.req.formData().catch(() => undefined)
  const file = form?.get('file')
  if (!(file instanceof File)) {
    return c.json({ error: 'expected a multipart upload with a "file" part' }, 400)
  }
  if (file.size > MAX_LOGO_BYTES) {
    return c.json({ error: `a logo must be ${MAX_LOGO_BYTES} bytes or smaller`, code: 'too_large' }, 413)
  }

  const bytes = new Uint8Array(await file.arrayBuffer())
  const type = detectImageType(bytes)
  if (!type) {
    // The filename is not echoed back: it is attacker-chosen text and this
    // message may well be rendered.
    return c.json({ error: 'that file is not a PNG, JPEG, GIF or WebP image', code: 'not_an_image' }, 400)
  }

  const digest = await crypto.subtle.digest('SHA-256', bytes)
  const hash = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
  const key = `batches/${batchId}/${hash}.${type.ext}`

  await c.env.LOGOS.put(key, bytes, { httpMetadata: { contentType: type.mime } })

  const logoUrl = `/api/logos/${key}`

  // Branding is a JSON column, so the logo URL is merged into whatever is
  // already there rather than replacing the object — an upload must not reset
  // the society's colour and title.
  const row = await c.env.DB
    .prepare(`SELECT branding FROM batch WHERE id = ?`)
    .bind(batchId)
    .first<Pick<BatchRow, 'branding'>>()
  if (!row) return c.json({ error: 'not found' }, 404)
  const branding = { ...(JSON.parse(row.branding) as Record<string, unknown>), logo_url: logoUrl }

  await c.env.DB.batch([
    c.env.DB.prepare(`UPDATE batch SET branding = ? WHERE id = ?`).bind(JSON.stringify(branding), batchId),
    // No detail: the filename is the officer's own, and it is not worth
    // recording in a table that cannot be purged.
    auditLogStatement(c.env.DB, { batchId, role: 'officer', action: 'logo.upload' }),
  ])

  return c.json({ logo_url: logoUrl }, 201)
})

/**
 * Public delivery. A logo is public branding: it is rendered on the ballot page
 * before anyone signs in.
 *
 * The content type comes from R2's stored metadata, which came from the magic
 * bytes at upload. Never from the request, and never from the key's extension.
 */
const logoDelivery = new Hono<{ Bindings: Env }>()

logoDelivery.get('/api/logos/:key{.+}', async (c) => {
  const object = await c.env.LOGOS.get(pathParam(c, 'key'))
  if (!object) return c.json({ error: 'not found' }, 404)

  return new Response(object.body, {
    headers: {
      'content-type': object.httpMetadata?.contentType ?? 'application/octet-stream',
      'cache-control': CACHE_CONTROL,
      etag: object.httpEtag,
    },
  })
})

logo.route('/', logoDelivery)
