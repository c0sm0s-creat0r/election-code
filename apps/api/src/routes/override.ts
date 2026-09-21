/**
 * The returning officer's tie-break override.
 *
 * Spec §3 puts this at the end of the resolution ladder: countback, then a
 * seeded draw, then the officer — who "may override any tie-break, which
 * requires a reason, is written to `audit_log`, and appears in the result
 * document". Constitutions that require lots to be drawn in the room need it.
 *
 * **The field is `resolved_id`, not `winner_id`.** Spec §5 originally named it
 * `winner_id`, which is a trap: for `kind: 'exclusion'` the id in
 * `TieBreakRecord.resolved` is the candidate **excluded**, not the survivor. A
 * UI built from that name would say "pick the winner" and collect the exact
 * opposite of the officer's intent, producing a result that looks right. The
 * response therefore echoes each tie's `kind` so a frontend can label the
 * control truthfully, and spec §5 has been amended.
 *
 * **An override never edits the old result.** It writes a new `election_result`
 * row with `supersedes` pointing at the previous one. Spec §2 wants "the officer
 * changed the tie-break and the winner changed" to remain a visible fact with
 * both counts attached, so nothing is ever deleted.
 */
import { Hono } from 'hono'
import { z } from 'zod'
import type { TieBreakRecord } from '@election/core'
import { recordAudit } from '../db/audit.js'
import { requireRole, requireSession, type AuthedEnv } from '../middleware/requireRole.js'
import { pathParam } from '../http/params.js'
import { loadSealed, currentResult, resultDocument, computeAndStore, sealedError } from './result.js'

const overrideSchema = z.object({
  tie_break_id: z.string().min(1).max(64),
  resolved_id: z.string().min(1).max(64),
  // Trimmed before the length check, so "   " is a missing reason rather than a
  // three-character one. Spec §3 requires a reason; an empty one would satisfy
  // the letter of that and none of the point.
  reason: z.string().transform((s) => s.trim()).refine((s) => s.length > 0, {
    message: 'reason is required',
  }),
})

/**
 * Every override already in force, keyed as `CountInput.overrides` expects.
 *
 * Read back off the stored tie-breaks rather than kept in a column of their own:
 * a `TieBreakRecord` with `method: 'officer_override'` *is* the record of one,
 * and it already carries the resolved candidate and the reason. A second store
 * would be a second source of truth to keep in step.
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
  const electionId = pathParam(c, 'eid')

  const sealed = await loadSealed(c.env.DB, batchId, electionId)
  if ('error' in sealed) return sealedError(c, sealed)

  const current = await currentResult(c.env.DB, electionId)
  if (!current) {
    // Nothing to override yet. Counting first is the officer's decision to
    // make, not something to do implicitly on their behalf.
    return c.json({ error: 'count the election before overriding a tie-break', code: 'not_counted' }, 409)
  }

  const parsed = overrideSchema.safeParse(await c.req.json().catch(() => undefined))
  if (!parsed.success) {
    return c.json({ error: parsed.error.issues[0]?.message ?? 'invalid request body' }, 400)
  }
  const { tie_break_id: tieBreakId, resolved_id: resolvedId, reason } = parsed.data

  const tieBreaks = JSON.parse(current.tie_breaks) as TieBreakRecord[]
  const target = tieBreaks.find((t) => t.id === tieBreakId)
  // `count` throws on both of these, which would surface as a 500. They are
  // bad input, and the officer needs to be told which of the two it was.
  if (!target) {
    return c.json({ error: `no tie-break ${tieBreakId} in this count`, code: 'unknown_tie_break' }, 400)
  }
  if (!target.candidates.includes(resolvedId)) {
    return c.json(
      { error: 'that candidate was not party to this tie-break', code: 'candidate_not_in_tie', kind: target.kind },
      400,
    )
  }

  // Accumulate: an override must not silently discard an earlier one, or the
  // officer would be told their decision stands while the result says it was
  // never applied.
  const overrides = { ...overridesInForce(tieBreaks), [tieBreakId]: { candidateId: resolvedId, reason } }

  await computeAndStore(c.env.DB, batchId, sealed, overrides, current.id)

  // The officer's decision, separate from the count it caused. Spec §3 requires
  // the reason in audit_log; `tie_override` is the allow-listed variant that
  // carries it, and a tie-break id and a reason name no person and no ballot.
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
