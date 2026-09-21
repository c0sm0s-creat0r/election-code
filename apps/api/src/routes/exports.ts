/**
 * Everything a disputing party needs to check the work themselves.
 *
 * - **attendance** is the roll mark-off: who voted, never what.
 * - **ballots** is the anonymous box. With the `voided` column it is now
 *   sufficient to recompute `ballots_sha256`, so a recipient can confirm these
 *   are the sealed ballots *before* recounting them — that was the gap spec §2
 *   used to record.
 * - **candidates** travels with the ballots because `recount` needs both halves:
 *   a preference naming an absent candidate is refused, so the ballot file alone
 *   cannot be replayed.
 * - **result.json** is the sealed count with every tie-break and its reasoning.
 *
 * `Content-Disposition` is already in Plan 2a's CORS `exposeHeaders`, so a
 * frontend can fetch these to a blob and read the filename off the response.
 */
import { Hono } from 'hono'
import type { Context } from 'hono'
import { toBallotsCsv, toCandidatesCsv, type ExportBallot } from '@election/core'
import { requireRole, requireSession, type AuthedEnv } from '../middleware/requireRole.js'
import { pathParam } from '../http/params.js'
import { loadSealed, currentResult, resultDocument, sealedError } from './result.js'
import type { BallotRow, CandidateRow } from '../db/types.js'

/** Quote every field: the reader in `@election/core` is quote-aware, and a society name can contain a comma. */
const csvField = (value: string): string => `"${value.replace(/"/g, '""')}"`

const csv = (header: readonly string[], rows: readonly string[][]): string =>
  [header.join(','), ...rows.map((r) => r.map(csvField).join(','))].join('\n') + '\n'

/** A CSV response the browser saves rather than renders. */
const csvResponse = (c: Context<AuthedEnv>, filename: string, body: string) =>
  c.body(body, 200, {
    'content-type': 'text/csv; charset=utf-8',
    'content-disposition': `attachment; filename="${filename}"`,
  })

export const exports_ = new Hono<AuthedEnv>()

/**
 * Attendance for one election: the `vote_receipt` mark-off, with names from the
 * roll.
 *
 * LEFT JOIN, not an inner one. The post-AGM purge deletes `voter_roll`, and an
 * inner join would then return a header and no rows — which reads as "nobody
 * voted" rather than "the names are gone". Who voted is still a fact afterwards.
 */
exports_.get('/api/batches/:id/elections/:eid/attendance.csv', requireRole('officer'), async (c) => {
  const batchId = requireSession(c).batchId
  const electionId = pathParam(c, 'eid')

  const election = await c.env.DB
    .prepare(`SELECT id FROM election WHERE id = ? AND batch_id = ?`)
    .bind(electionId, batchId)
    .first<{ id: string }>()
  if (!election) return c.json({ error: 'not found' }, 404)

  const { results } = await c.env.DB
    .prepare(
      `SELECT vr.usu_id, r.first_name, r.last_name, vr.voted_at, vr.recast_count
         FROM vote_receipt vr
         LEFT JOIN voter_roll r ON r.batch_id = ?1 AND r.usu_id = vr.usu_id
        WHERE vr.election_id = ?2
        ORDER BY r.last_name, r.first_name, vr.usu_id`,
    )
    .bind(batchId, electionId)
    .all<{ usu_id: string; first_name: string | null; last_name: string | null; voted_at: number; recast_count: number }>()

  return csvResponse(
    c,
    `attendance-${electionId}.csv`,
    csv(
      ['usu_id', 'first_name', 'last_name', 'voted_at', 'recast_count'],
      results.map((r) => [r.usu_id, r.first_name ?? '', r.last_name ?? '', String(r.voted_at), String(r.recast_count)]),
    ),
  )
})

/** Attendance across every election in the batch, for the AGM minutes. */
exports_.get('/api/batches/:id/attendance.csv', requireRole('officer'), async (c) => {
  const batchId = requireSession(c).batchId

  const { results } = await c.env.DB
    .prepare(
      `SELECT e.id AS election_id, e.name AS election_name,
              vr.usu_id, r.first_name, r.last_name, vr.voted_at
         FROM vote_receipt vr
         JOIN election e ON e.id = vr.election_id
         LEFT JOIN voter_roll r ON r.batch_id = ?1 AND r.usu_id = vr.usu_id
        WHERE e.batch_id = ?1
        ORDER BY e.rowid, r.last_name, r.first_name, vr.usu_id`,
    )
    .bind(batchId)
    .all<{
      election_id: string; election_name: string; usu_id: string
      first_name: string | null; last_name: string | null; voted_at: number
    }>()

  return csvResponse(
    c,
    `attendance-${batchId}.csv`,
    csv(
      ['election_id', 'election_name', 'usu_id', 'first_name', 'last_name', 'voted_at'],
      results.map((r) => [
        r.election_id, r.election_name, r.usu_id,
        r.first_name ?? '', r.last_name ?? '', String(r.voted_at),
      ]),
    ),
  )
})

/**
 * The anonymous ballot box, sealed and exported.
 *
 * `ORDER BY id` is explicit. `ballot` is `WITHOUT ROWID` so physical order is
 * already UUID order — which is exactly why it is written out, because spec §2
 * defines the digest as sorted by id and that must come from the query.
 */
exports_.get('/api/batches/:id/elections/:eid/ballots.csv', requireRole('officer'), async (c) => {
  const batchId = requireSession(c).batchId
  const electionId = pathParam(c, 'eid')

  const sealed = await loadSealed(c.env.DB, batchId, electionId)
  if ('error' in sealed) return sealedError(c, sealed)

  const { results } = await c.env.DB
    .prepare(`SELECT id, preferences, voided FROM ballot WHERE election_id = ? ORDER BY id`)
    .bind(electionId)
    .all<Pick<BallotRow, 'id' | 'preferences' | 'voided'>>()

  const ballots: ExportBallot[] = results.map((r) => ({
    id: r.id,
    preferences: JSON.parse(r.preferences) as string[],
    voided: r.voided === 1,
  }))

  return csvResponse(c, `ballots-${electionId}.csv`, toBallotsCsv(ballots))
})

/** The other half of a recount's input. */
exports_.get('/api/batches/:id/elections/:eid/candidates.csv', requireRole('officer'), async (c) => {
  const batchId = requireSession(c).batchId
  const electionId = pathParam(c, 'eid')

  const sealed = await loadSealed(c.env.DB, batchId, electionId)
  if ('error' in sealed) return sealedError(c, sealed)

  const { results } = await c.env.DB
    .prepare(`SELECT id, name FROM candidate WHERE election_id = ? ORDER BY ordinal`)
    .bind(electionId)
    .all<Pick<CandidateRow, 'id' | 'name'>>()

  return csvResponse(c, `candidates-${electionId}.csv`, toCandidatesCsv(results))
})

/** The sealed result document: the same shape the result endpoint serves. */
exports_.get('/api/batches/:id/elections/:eid/result.json', requireRole('officer'), async (c) => {
  const batchId = requireSession(c).batchId
  const electionId = pathParam(c, 'eid')

  const sealed = await loadSealed(c.env.DB, batchId, electionId)
  if ('error' in sealed) return sealedError(c, sealed)

  const stored = await currentResult(c.env.DB, electionId)
  // Deliberately does not count on demand: an export is a copy of the record,
  // and producing the record is the officer's decision at /result.
  if (!stored) {
    return c.json({ error: 'count the election before exporting its result', code: 'not_counted' }, 409)
  }

  c.header('content-disposition', `attachment; filename="result-${electionId}.json"`)
  return c.json(resultDocument(sealed, stored))
})
