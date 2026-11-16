/**
 * USU member-roll import: preview, then commit.
 *
 * Two steps, so the officer sees the counts ("1,298 eligible, 4 excluded, 0
 * skipped") before anything is written.
 *
 * Only id, names and eligibility are stored. Emails, payments, tags and notes
 * are discarded here. Spec §2's retention claim depends on it.
 */
import { Hono } from 'hono'
import type { Context } from 'hono'
import { parseUsuExport, type RollMember } from '@election/core'
import { auditLogStatement } from '../db/audit.js'
import { requireRole, requireSession, type AuthedEnv } from '../middleware/requireRole.js'

/** The real export is ~256 KB. */
const MAX_UPLOAD_BYTES = 2 * 1024 * 1024

/**
 * D1 caps statements per `batch()`, so the import is chunked. Each chunk is
 * its own transaction. A partial failure is recoverable: the upsert is
 * idempotent and the officer can re-upload.
 */
const CHUNK = 100

type Preview = {
  total: number
  eligible: number
  excluded: number
  skipped: number
  shifted: boolean
}

/** `total` is importable rows only. `skipped` is reported separately. */
const toPreview = (r: { members: RollMember[]; eligible: number; excluded: number; skipped: number; shifted: boolean }): Preview => ({
  total: r.members.length,
  eligible: r.eligible,
  excluded: r.excluded,
  skipped: r.skipped,
  shifted: r.shifted,
})

type ReadResult = { ok: true; text: string } | { ok: false; message: string }

async function readUpload(c: Context<AuthedEnv>): Promise<ReadResult> {
  const form = await c.req.formData().catch(() => undefined)
  const file = form?.get('file')
  if (!(file instanceof File)) return { ok: false, message: 'expected a multipart upload with a "file" part' }
  if (file.size > MAX_UPLOAD_BYTES) {
    return { ok: false, message: `file is larger than ${MAX_UPLOAD_BYTES} bytes` }
  }
  return { ok: true, text: await file.text() }
}

export const roll = new Hono<AuthedEnv>()

roll.post('/api/batches/:id/roll/preview', requireRole('officer'), async (c) => {
  const upload = await readUpload(c)
  if (!upload.ok) return c.json({ error: upload.message }, 400)

  try {
    return c.json(toPreview(parseUsuExport(upload.text)))
  } catch (err) {
    // parseUsuExport throws only on an unusable file. Answer 400. Its message
    // names no member.
    return c.json({ error: err instanceof Error ? err.message : 'could not read the export' }, 400)
  }
})

roll.post('/api/batches/:id/roll', requireRole('officer'), async (c) => {
  // From the session, not the path. requireRole has checked they match.
  const batchId = requireSession(c).batchId
  const upload = await readUpload(c)
  if (!upload.ok) return c.json({ error: upload.message }, 400)

  let parsed
  try {
    parsed = parseUsuExport(upload.text)
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : 'could not read the export' }, 400)
  }

  // Upsert: re-importing a corrected export updates eligibility. The SET list
  // must never include `added_at_door` (migration 0004).
  const statements = parsed.members.map((m) =>
    c.env.DB
      .prepare(
        `INSERT INTO voter_roll (batch_id, usu_id, first_name, last_name, eligible)
         VALUES (?,?,?,?,?)
         ON CONFLICT(batch_id, usu_id) DO UPDATE SET
           first_name = excluded.first_name,
           last_name  = excluded.last_name,
           eligible   = excluded.eligible`,
      )
      .bind(batchId, m.usuId, m.firstName, m.lastName, m.eligible ? 1 : 0),
  )

  for (let i = 0; i < statements.length; i += CHUNK) {
    await c.env.DB.batch(statements.slice(i, i + CHUNK))
  }

  await c.env.DB.batch([
    auditLogStatement(c.env.DB, {
      batchId,
      role: 'officer',
      action: 'roll.import',
      detail: {
        kind: 'roll_import',
        total: parsed.members.length,
        eligible: parsed.eligible,
        excluded: parsed.excluded,
        skipped: parsed.skipped,
      },
    }),
  ])

  return c.json(toPreview(parsed))
})

/**
 * Whether a roll exists yet, for the officer's election screen. Counts only;
 * names stay behind the door role.
 */
roll.get('/api/batches/:id/officer/roll/summary', requireRole('officer'), async (c) => {
  const batchId = requireSession(c).batchId
  const row = await c.env.DB
    .prepare(
      `SELECT count(*) AS total, coalesce(sum(eligible), 0) AS eligible
         FROM voter_roll WHERE batch_id = ?`,
    )
    .bind(batchId)
    .first<{ total: number; eligible: number }>()
  return c.json({ total: row?.total ?? 0, eligible: row?.eligible ?? 0 })
})
