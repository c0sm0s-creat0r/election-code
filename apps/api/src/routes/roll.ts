/**
 * USU member-roll import: preview, then commit.
 *
 * **Why two steps.** The officer sees "1,298 eligible, 4 excluded, 0 skipped"
 * before anything is written. A third-party export that silently drops members
 * is the failure this exists to catch — `parseUsuExport` counts `skipped` for
 * exactly that reason, and a preview is the only place a human can notice the
 * number is wrong while it is still cheap to fix.
 *
 * **What is stored is the whole privacy posture.** The export carries email
 * addresses, membership payments, event payments, tags, officer notes and
 * expiry dates. `voter_roll` has five columns and none of them is any of that.
 * Spec §2's retention claim — that `voter_roll` and `check_in` are all the
 * personal data held — is only true because this route throws the rest away.
 */
import { Hono } from 'hono'
import type { Context } from 'hono'
import { parseUsuExport, type RollMember } from '@election/core'
import { auditLogStatement } from '../db/audit.js'
import { requireRole, requireSession, type AuthedEnv } from '../middleware/requireRole.js'

/** The real export is ~256 KB. A ceiling, not a target. */
const MAX_UPLOAD_BYTES = 2 * 1024 * 1024

/**
 * D1 caps statements per `batch()` call, and the real roll is 1,302 rows, so
 * the import is chunked. Each chunk is its own transaction: a failure part-way
 * leaves a partially imported roll. That is acceptable *because the import is
 * idempotent* — the officer re-uploads the same file and the upsert converges.
 * A corrupt file, by contrast, is rejected before any chunk runs at all.
 */
const CHUNK = 100

type Preview = {
  total: number
  eligible: number
  excluded: number
  skipped: number
  shifted: boolean
}

/**
 * `ImportResult` has no `total`: it is the number of rows actually importable,
 * reported beside `skipped` rather than having it folded in, so "6 of 7 rows"
 * cannot be read as "7 members".
 */
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
    // parseUsuExport throws only on a structurally unusable file — a missing
    // header, or a quoted field that never closes. That is a 400 about the
    // officer's file, not a 500 about ours. Its message already says no roll
    // was imported, and it names no member, so it is safe to return.
    return c.json({ error: err instanceof Error ? err.message : 'could not read the export' }, 400)
  }
})

roll.post('/api/batches/:id/roll', requireRole('officer'), async (c) => {
  // Taken from the verified session, not from the path: requireRole has
  // already proved the two match, and `param('id')` is `string | undefined`
  // while a session's batchId is not.
  const batchId = requireSession(c).batchId
  const upload = await readUpload(c)
  if (!upload.ok) return c.json({ error: upload.message }, 400)

  let parsed
  try {
    parsed = parseUsuExport(upload.text)
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : 'could not read the export' }, 400)
  }

  // Upsert, not insert: a second import of a corrected export must update
  // eligibility rather than fail or leave a departed member voting. The
  // officer will re-import — the AGM is the one day the roll is edited.
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
