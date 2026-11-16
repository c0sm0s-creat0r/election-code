/**
 * The returning officer's tie-break override: the last step, after countback
 * and the seeded draw (spec §3). It needs a reason, which goes to `audit_log`
 * and the result document.
 *
 * The field is `resolved_id`, not a winner: for `kind: 'exclusion'` it is the
 * candidate excluded. The response returns each tie's `kind` so a frontend
 * can label the control.
 *
 * An override does not edit a result. It writes a new `election_result` row
 * that supersedes the previous one. Both stay on record.
 */
import { Hono } from 'hono'
import { z } from 'zod'
import type { TieBreakRecord } from '@election/core'
import { recordAudit } from '../db/audit.js'
import { requireRole, requireSession, type AuthedEnv } from '../middleware/requireRole.js'
import { loadSealed, currentResult, resultDocument, computeAndStore, sealedError } from './result.js'

const overrideSchema = z.object({
  tie_break_id: z.string().min(1).max(64),
  resolved_id: z.string().min(1).max(64),
  // Trimmed first, so "   " is missing.
  reason: z.string().transform((s) => s.trim()).refine((s) => s.length > 0, {
    message: 'reason is required',
  }),
})

/**
 * Every override in force, keyed as `CountInput.overrides` expects. Read
 * from the stored tie-breaks.
 */
const overridesInForce = (tieBreaks: TieBreakRecord[]): Record<string, { candidateId: string; reason: string }> => {
  const overrides: Record<string, { candidateId: string; reason: string }> = {}
  for (const tb of tieBreaks) {
    if (tb.method === 'officer_override') {
      overrides[tb.id] = { candidateId: tb.resolved, reason: tb.reason ?? '' }
    }
  }
  return overrides
}

export const override = new Hono<AuthedEnv>()

override.post('/api/batches/:id/elections/:eid/result/override', requireRole('officer'), async (c) => {
  const batchId = requireSession(c).batchId
  const electionId = c.req.param('eid')

  const sealed = await loadSealed(c.env.DB, batchId, electionId)
  if ('error' in sealed) return sealedError(c, sealed)

  const current = await currentResult(c.env.DB, electionId)
  if (!current) {
    return c.json({ error: 'count the election before overriding a tie-break', code: 'not_counted' }, 409)
  }

  const parsed = overrideSchema.safeParse(await c.req.json().catch(() => undefined))
  if (!parsed.success) {
    return c.json({ error: parsed.error.issues[0]?.message ?? 'invalid request body' }, 400)
  }
  const { tie_break_id: tieBreakId, resolved_id: resolvedId, reason } = parsed.data

  const tieBreaks = JSON.parse(current.tie_breaks) as TieBreakRecord[]
  const target = tieBreaks.find((t) => t.id === tieBreakId)
  // `count` would throw on either. Both are bad input: 400.
  if (!target) {
    return c.json({ error: `no tie-break ${tieBreakId} in this count`, code: 'unknown_tie_break' }, 400)
  }
  if (!target.candidates.includes(resolvedId)) {
    return c.json(
      { error: 'that candidate was not party to this tie-break', code: 'candidate_not_in_tie', kind: target.kind },
      400,
    )
  }

  // Accumulate, so a new override keeps the earlier ones.
  const overrides = { ...overridesInForce(tieBreaks), [tieBreakId]: { candidateId: resolvedId, reason } }

  await computeAndStore(c.env.DB, batchId, sealed, overrides, current.id)

  // The decision is audited separately from the count. The detail names no
  // person and no ballot.
  await recordAudit(c.env.DB, {
    batchId,
    role: 'officer',
    action: 'result.override',
    detail: { kind: 'tie_override', tieBreakId, reason },
  })

  const stored = await currentResult(c.env.DB, electionId)
  if (!stored) throw new Error('stored result missing immediately after being written')
  return c.json(resultDocument(sealed, stored))
})
