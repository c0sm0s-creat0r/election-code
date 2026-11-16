/**
 * The result of a sealed election.
 *
 * - No tally before `closed`: a draft or open election gets a 409.
 * - Voided ballots are sealed but not counted.
 * - The count runs once and is stored. Later requests read the stored row.
 *   An override writes a new row that supersedes it.
 *
 * All counting logic is in `@election/core`.
 */
import { Hono } from 'hono'
import type { Context } from 'hono'
import { count } from '@election/core'
import { auditLogStatement } from '../db/audit.js'
import { requireRole, requireSession, type AuthedEnv } from '../middleware/requireRole.js'
import type { CandidateRow, CountBallotRow, ElectionResultRow, ElectionRow, ElectionSealRow } from '../db/types.js'

/** A sealed election, with the seal it was closed under. */
export type SealedElection = {
  election: Pick<ElectionRow, 'id' | 'name' | 'seats' | 'status'>
  seal: Pick<ElectionSealRow, 'closed_at' | 'ballot_count' | 'ballots_sha256'>
}

/**
 * Loads a closed, sealed election, or says why not. Shared by the result,
 * override and export routes so their refusals match.
 */
export async function loadSealed(
  db: D1Database,
  batchId: string,
  electionId: string,
): Promise<SealedElection | { error: 'not_found' } | { error: 'not_closed'; status: ElectionRow['status'] }> {
  const row = await db
    .prepare(
      `SELECT e.id, e.name, e.seats, e.status,
              s.closed_at, s.ballot_count, s.ballots_sha256
         FROM election e
         LEFT JOIN election_seal s ON s.election_id = e.id
        WHERE e.id = ? AND e.batch_id = ?`,
    )
    .bind(electionId, batchId)
    .first<
      Pick<ElectionRow, 'id' | 'name' | 'seats' | 'status'> &
      Partial<Pick<ElectionSealRow, 'closed_at' | 'ballot_count' | 'ballots_sha256'>>
    >()

  if (!row) return { error: 'not_found' }
  if (row.status !== 'closed') return { error: 'not_closed', status: row.status }

  // Closed but unsealed is the retry window in close.ts. With no digest there
  // is no seed for a draw, so treat it as not yet closed.
  if (row.ballots_sha256 === null || row.ballots_sha256 === undefined) {
    return { error: 'not_closed', status: row.status }
  }

  return {
    election: { id: row.id, name: row.name, seats: row.seats, status: row.status },
    seal: {
      closed_at: row.closed_at as number,
      ballot_count: row.ballot_count as number,
      ballots_sha256: row.ballots_sha256,
    },
  }
}

/** The stored result in force: the one no other row supersedes. */
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

/** The wire shape of a result document. The result.json export serves it too. */
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
 * Counts the sealed, non-voided ballots and stores the result. The draw seed
 * derives from the seal's digest, so anyone can re-check the draw from the
 * exported ballots.
 */
export async function computeAndStore(
  db: D1Database,
  batchId: string,
  sealed: SealedElection,
  overrides: Record<string, { candidateId: string; reason: string }>,
  supersedes: number | null,
): Promise<ElectionResultRow> {
  const electionId = sealed.election.id

  const [{ results: candidates }, { results: ballots }] = await Promise.all([
    db.prepare(`SELECT id, name FROM candidate WHERE election_id = ? ORDER BY ordinal`)
      .bind(electionId)
      .all<Pick<CandidateRow, 'id' | 'name'>>(),
    // ORDER BY id: the count must not depend on storage order.
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
    overrides,
  })

  const [inserted] = await db.batch<ElectionResultRow>([
    db.prepare(
      `INSERT INTO election_result
         (election_id, computed_at, quota, rounds, winners, tie_breaks, overridden, supersedes)
       VALUES (?,?,?,?,?,?,?,?) RETURNING *`,
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

  const stored = inserted?.results[0]
  if (!stored) throw new Error('stored result missing immediately after being written')
  return stored
}

/** 409 or 404 for a failed load. One place, so every route agrees. */
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
  const electionId = c.req.param('eid')

  const sealed = await loadSealed(c.env.DB, batchId, electionId)
  if ('error' in sealed) return sealedError(c, sealed)

  const existing = await currentResult(c.env.DB, electionId)
  if (existing) return c.json(resultDocument(sealed, existing))

  return c.json(resultDocument(sealed, await computeAndStore(c.env.DB, batchId, sealed, {}, null)))
})
