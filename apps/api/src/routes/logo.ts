/**
 * Society logo upload and delivery.
 *
 * Upload needs an officer session. The magic bytes set the type, never the
 * filename or the request. Objects are in R2 under a content-hash key,
 * `batches/<batchId>/<sha256>.<ext>`: uploads cannot collide, and a repeat
 * upload is idempotent.
 */
import { Hono } from 'hono'
import { auditLogStatement } from '../db/audit.js'
import { requireRole, requireSession, type AuthedEnv } from '../middleware/requireRole.js'
import { pathParam } from '../http/params.js'
import { detectImageType } from '../lib/imageType.js'
import { sha256HexBytes } from '../lib/hash.js'
import type { BatchRow } from '../db/types.js'
import type { Env } from '../index.js'

/** A logo on a ballot page. The one in use is ~40 KB. */
const MAX_LOGO_BYTES = 2 * 1024 * 1024

/** Safe because the key is a content hash: different bytes get a different URL. */
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
    // The filename is attacker-chosen. Do not echo it.
    return c.json({ error: 'that file is not a PNG, JPEG, GIF or WebP image', code: 'not_an_image' }, 400)
  }

  const key = `batches/${batchId}/${await sha256HexBytes(bytes)}.${type.ext}`

  await c.env.LOGOS.put(key, bytes, { httpMetadata: { contentType: type.mime } })

  const logoUrl = `/api/logos/${key}`

  // Merge into the branding JSON, so an upload keeps colour and title.
  const row = await c.env.DB
    .prepare(`SELECT branding FROM batch WHERE id = ?`)
    .bind(batchId)
    .first<Pick<BatchRow, 'branding'>>()
  if (!row) return c.json({ error: 'not found' }, 404)
  const branding = { ...(JSON.parse(row.branding) as Record<string, unknown>), logo_url: logoUrl }

  await c.env.DB.batch([
    c.env.DB.prepare(`UPDATE batch SET branding = ? WHERE id = ?`).bind(JSON.stringify(branding), batchId),
    auditLogStatement(c.env.DB, { batchId, role: 'officer', action: 'logo.upload' }),
  ])

  return c.json({ logo_url: logoUrl }, 201)
})

/**
 * Public: the logo is on the ballot page before sign-in. The content type
 * comes from R2 metadata, set from the magic bytes.
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
