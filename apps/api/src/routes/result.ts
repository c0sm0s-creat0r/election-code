/**
 * The result of a sealed election.
 *
 * **No tally exists before `closed`.** Spec §4. This endpoint answers 409 on a
 * draft or open election — not a partial count, not an empty result. An officer
 * who can watch the result develop and choose when to stop makes every other
 * control decorative.
 *
 * **Voided ballots are sealed but not counted.** They stay in the table so the
 * digest covers them, and they are excluded from the count. That distinction is
 * the entire reason `ballot.voided` exists.
 *
 * **The count is computed once and stored.** A second request is served from
 * the stored `election_result` row. Recomputing would make the result depend on
 * the code that happened to be deployed rather than on a record — and Task 3's
 * override has to produce a *new versioned row*, not quietly change an old
 * answer.
 *
 * **This file contains no election logic.** `@election/core` counts; if a result
 * looks wrong the bug is there, where 135 tests and a differential against the
 * legacy implementation are waiting for it.
 */
import { Hono } from 'hono'
import type { Context } from 'hono'
import { count, type CountResult } from '@election/core'
import { auditLogStatement } from '../db/audit.js'
import { requireRole, requireSession, type AuthedEnv } from '../middleware/requireRole.js'
import { pathParam } from '../http/params.js'
import type { CandidateRow, CountBallotRow, ElectionResultRow, ElectionRow, ElectionSealRow } from '../db/types.js'

/** A sealed election, with the seal it was closed under. */
export type SealedElection = {
  election: Pick<ElectionRow, 'id' | 'name' | 'seats' | 'status'>
  seal: Pick<ElectionSealRow, 'closed_at' | 'ballot_count' | 'ballots_sha256'>
}

/**
 * Loads an election that is closed AND sealed, or explains why not. Shared with
 * the override and export routes: every one of them is meaningless before the
 * box is sealed, and each should refuse for the same reason in the same words.
 */
export async function loadSealed(
  db: D1Database,
  batchId: string,
  electionId: string,
): Promise<SealedElection | { error: 'not_found' } | { error: 'not_closed'; status: ElectionRow['status'] }> {
  const election = await db
    .prepare(`SELECT id, name, seats, status FROM election WHERE id = ? AND batch_id = ?`)
    .bind(electionId, batchId)
    .first<Pick<ElectionRow, 'id' | 'name' | 'seats' | 'status'>>()
  if (!election) return { error: 'not_found' }
  if (election.status !== 'closed') return { error: 'not_closed', status: election.status }

  const seal = await db
    .prepare(`SELECT closed_at, ballot_count, ballots_sha256 FROM election_seal WHERE election_id = ?`)
    .bind(electionId)
    .first<Pick<ElectionSealRow, 'closed_at' | 'ballot_count' | 'ballots_sha256'>>()
  // Closed but unsealed is the retry window in routes/close.ts. Treat it as not
  // yet closed rather than counting an unsealed box: without a digest there is
  // nothing to seed a tie-break draw from, and nothing to prove later that
  // these were the ballots.
  if (!seal) return { error: 'not_closed', status: election.status }

  return { election, seal }
}

/** The stored result currently in force: the one nothing else supersedes. */
export async function currentResult(db: D1Database, electionId: string): Promise<ElectionResultRow | null> {
  return db
    .prepare(
      `SELECT * FROM election_result
        WHERE election_id = ?1
          AND id NOT IN (SELECT supersedes FROM election_result WHERE election_id = ?1 AND supersedes IS NOT NULL)
        ORDER BY id DESC LIMIT 1`,
    )
    .bind(electionId)
    .first<ElectionResultRow>()
}

/** The wire shape of a result document, shared with the export in Task 5. */
export const resultDocument = (
  sealed: SealedElection,
  row: ElectionResultRow,
): Record<string, unknown> => ({
  election: {
    id: sealed.election.id,
    name: sealed.election.name,
    seats: sealed.election.seats,
  },
  closed_at: sealed.seal.closed_at,
  ballot_count: sealed.seal.ballot_count,
  ballots_sha256: sealed.seal.ballots_sha256,
  computed_at: row.computed_at,
  overridden: row.overridden === 1,
  quota: JSON.parse(row.quota) as unknown,
  rounds: JSON.parse(row.rounds) as unknown,
  winners: JSON.parse(row.winners) as unknown,
  tie_breaks: JSON.parse(row.tie_breaks) as unknown,
})

/**
 * Runs the count over the sealed, non-voided ballots and stores it.
 *
 * `ballotsSha256` comes from the seal, which is what makes a seeded draw
 * reproducible: anyone holding the exported ballots can recompute the digest,
 * re-derive the seed and check the draw was not steered.
 */
export async function computeAndStore(
  db: D1Database,
  batchId: string,
  sealed: SealedElection,
  overrides: Record<string, { candidateId: string; reason: string }>,
  supersedes: number | null,
): Promise<CountResult> {
  const electionId = sealed.election.id

  const [{ results: candidates }, { results: ballots }] = await Promise.all([
    db.prepare(`SELECT id, name FROM candidate WHERE election_id = ? ORDER BY ordinal`)
      .bind(electionId)
      .all<Pick<CandidateRow, 'id' | 'name'>>(),
    // voided = 0: sealed, not counted. ORDER BY id for the same reason the seal
    // has it — the count must not depend on storage order.
    db.prepare(`SELECT id, preferences FROM ballot WHERE election_id = ? AND voided = 0 ORDER BY id`)
      .bind(electionId)
      .all<CountBallotRow>(),
  ])

  const result = await count({
    candidates,
    ballots: ballots.map((b) => ({ id: b.id, preferences: JSON.parse(b.preferences) as string[] })),
    seats: sealed.election.seats,
    electionId,
    ballotsSha256: sealed.seal.ballots_sha256,
    ...(Object.keys(overrides).length > 0 ? { overrides } : {}),
  })

  await db.batch([
    db.prepare(
      `INSERT INTO election_result
         (election_id, computed_at, quota, rounds, winners, tie_breaks, overridden, supersedes)
       VALUES (?,?,?,?,?,?,?,?)`,
    ).bind(
      electionId,
      Date.now(),
      JSON.stringify(result.quota),
      JSON.stringify(result.rounds),
      JSON.stringify(result.winners),
      JSON.stringify(result.tieBreaks),
      supersedes === null ? 0 : 1,
      supersedes,
    ),
    auditLogStatement(db, {
      batchId,
      role: 'officer',
      action: supersedes === null ? 'election.count' : 'election.count.override',
      detail: { kind: 'count', rounds: result.rounds.length, winners: result.winners.length },
    }),
  ])

  return result
}

/** 409 or 404 for a load that failed, in one place so every route agrees. */
export function sealedError(
  c: Context<AuthedEnv>,
  failure: { error: 'not_found' } | { error: 'not_closed'; status: ElectionRow['status'] },
): Response {
  if (failure.error === 'not_found') return c.json({ error: 'not found' }, 404)
  return c.json(
    {
      error: `no result exists until voting is closed and sealed (election is ${failure.status})`,
      code: 'not_sealed',
    },
    409,
  )
}

export const result = new Hono<AuthedEnv>()

result.get('/api/batches/:id/elections/:eid/result', requireRole('officer'), async (c) => {
  const batchId = requireSession(c).batchId
  const electionId = pathParam(c, 'eid')

  const sealed = await loadSealed(c.env.DB, batchId, electionId)
  if ('error' in sealed) return sealedError(c, sealed)

  const existing = await currentResult(c.env.DB, electionId)
  if (existing) return c.json(resultDocument(sealed, existing))

  await computeAndStore(c.env.DB, batchId, sealed, {}, null)

  const stored = await currentResult(c.env.DB, electionId)
  // The insert above just wrote it, inside a transaction that either committed
  // or threw. A miss here is not a missing result, it is a broken invariant.
  if (!stored) throw new Error('stored result missing immediately after being written')
  return c.json(resultDocument(sealed, stored))
})
