/**
 * What a disputing party needs to check the count.
 *
 * - attendance: the roll mark-off. Who voted, never what.
 * - check-ins: who was in the room, voted or not.
 * - ballots: the anonymous box, with `voided`, so `ballots_sha256` can be
 *   recomputed before recounting.
 * - candidates: the rest of `recount`'s input.
 * - result.json: the sealed count with every tie-break.
 */
import { Hono } from 'hono'
import type { Context } from 'hono'
import { toBallotsCsv, toCandidatesCsv, type ExportBallot } from '@election/core'
import { requireRole, requireSession, type AuthedEnv } from '../middleware/requireRole.js'
import { loadSealed, currentResult, resultDocument, sealedError } from './result.js'
import type { BallotRow, CandidateRow } from '../db/types.js'

/** Every field quoted: a society name can contain a comma. */
const csvField = (value: string): string => `"${value.replace(/"/g, '""')}"`

const csv = (header: readonly string[], rows: readonly string[][]): string =>
  [header.join(','), ...rows.map((r) => r.map(csvField).join(','))].join('\n') + '\n'

/** A CSV response the browser saves, not renders. */
const csvResponse = (c: Context<AuthedEnv>, filename: string, body: string) =>
  c.body(body, 200, {
    'content-type': 'text/csv; charset=utf-8',
    'content-disposition': `attachment; filename="${filename}"`,
  })

export const exports_ = new Hono<AuthedEnv>()

/**
 * Attendance for one election. LEFT JOIN: the post-AGM purge deletes
 * `voter_roll`, and an inner join would then show nobody voted.
 */
exports_.get('/api/batches/:id/elections/:eid/attendance.csv', requireRole('officer'), async (c) => {
  const batchId = requireSession(c).batchId
  const electionId = c.req.param('eid')

  const election = await c.env.DB
    .prepare(`SELECT id FROM election WHERE id = ? AND batch_id = ?`)
    .bind(electionId, batchId)
    .first<{ id: string }>()
  if (!election) return c.json({ error: 'not found' }, 404)

  const { results } = await c.env.DB
    .prepare(
      `SELECT vr.usu_id, r.first_name, r.last_name, vr.voted_at, vr.recast_count,
              COALESCE(r.added_at_door, 0) AS added_at_door
         FROM vote_receipt vr
         LEFT JOIN voter_roll r ON r.batch_id = ?1 AND r.usu_id = vr.usu_id
        WHERE vr.election_id = ?2
        ORDER BY r.last_name, r.first_name, vr.usu_id`,
    )
    .bind(batchId, electionId)
    .all<{
      usu_id: string; first_name: string | null; last_name: string | null
      voted_at: number; recast_count: number; added_at_door: number
    }>()

  return csvResponse(
    c,
    `attendance-${electionId}.csv`,
    // `added_at_door` marks voters a door volunteer enrolled. COALESCE because
    // the roll may be purged.
    csv(
      ['usu_id', 'first_name', 'last_name', 'voted_at', 'recast_count', 'added_at_door'],
      results.map((r) => [
        r.usu_id, r.first_name ?? '', r.last_name ?? '',
        String(r.voted_at), String(r.recast_count), String(r.added_at_door),
      ]),
    ),
  )
})

/**
 * Who voted in each election in the batch, for the minutes. The path keeps
 * its old name for saved links. A member who checked in and did not vote is
 * in `check-ins.csv`, not here.
 */
exports_.get('/api/batches/:id/attendance.csv', requireRole('officer'), async (c) => {
  const batchId = requireSession(c).batchId

  const { results } = await c.env.DB
    .prepare(
      `SELECT e.id AS election_id, e.name AS election_name,
              vr.usu_id, r.first_name, r.last_name, vr.voted_at,
              COALESCE(r.added_at_door, 0) AS added_at_door
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
      added_at_door: number
    }>()

  return csvResponse(
    c,
    `voters-all-elections-${batchId}.csv`,
    csv(
      ['election_id', 'election_name', 'usu_id', 'first_name', 'last_name', 'voted_at', 'added_at_door'],
      results.map((r) => [
        r.election_id, r.election_name, r.usu_id,
        r.first_name ?? '', r.last_name ?? '', String(r.voted_at), String(r.added_at_door),
      ]),
    ),
  )
})

/**
 * The sealed ballot box. `ORDER BY id` because the digest is defined as
 * sorted by id.
 */
exports_.get('/api/batches/:id/elections/:eid/ballots.csv', requireRole('officer'), async (c) => {
  const batchId = requireSession(c).batchId
  const electionId = c.req.param('eid')

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

/** Guests get their own file: `attendance.csv` lists voters, and a guest did not vote. */
exports_.get('/api/batches/:id/guests.csv', requireRole('officer'), async (c) => {
  const batchId = requireSession(c).batchId
  const { results } = await c.env.DB
    .prepare(`SELECT name, note, checked_in_at FROM guest WHERE batch_id = ? ORDER BY checked_in_at`)
    .bind(batchId)
    .all<{ name: string; note: string | null; checked_in_at: number }>()

  return csvResponse(
    c,
    `guests-${batchId}.csv`,
    csv(['name', 'note', 'checked_in_at'], results.map((r) => [r.name, r.note ?? '', String(r.checked_in_at)])),
  )
})

/**
 * Everyone checked in at the door. An inner join is correct: `check_in`
 * cascades from `voter_roll`, so this is empty after the purge. `eligible`
 * is included because quorum counts eligible members only.
 */
exports_.get('/api/batches/:id/check-ins.csv', requireRole('officer'), async (c) => {
  const batchId = requireSession(c).batchId
  const { results } = await c.env.DB
    .prepare(
      `SELECT ci.usu_id, r.first_name, r.last_name, r.eligible, r.added_at_door, ci.checked_in_at
         FROM check_in ci
         JOIN voter_roll r ON r.batch_id = ci.batch_id AND r.usu_id = ci.usu_id
        WHERE ci.batch_id = ?
        ORDER BY ci.checked_in_at, ci.usu_id`,
    )
    .bind(batchId)
    .all<{
      usu_id: string; first_name: string; last_name: string
      eligible: number; added_at_door: number; checked_in_at: number
    }>()

  return csvResponse(
    c,
    `check-ins-${batchId}.csv`,
    csv(
      ['usu_id', 'first_name', 'last_name', 'eligible', 'added_at_door', 'checked_in_at'],
      results.map((r) => [
        r.usu_id, r.first_name, r.last_name,
        String(r.eligible), String(r.added_at_door), String(r.checked_in_at),
      ]),
    ),
  )
})

/** The rest of a recount's input. */
exports_.get('/api/batches/:id/elections/:eid/candidates.csv', requireRole('officer'), async (c) => {
  const batchId = requireSession(c).batchId
  const electionId = c.req.param('eid')

  const sealed = await loadSealed(c.env.DB, batchId, electionId)
  if ('error' in sealed) return sealedError(c, sealed)

  const { results } = await c.env.DB
    .prepare(`SELECT id, name FROM candidate WHERE election_id = ? ORDER BY ordinal`)
    .bind(electionId)
    .all<Pick<CandidateRow, 'id' | 'name'>>()

  return csvResponse(c, `candidates-${electionId}.csv`, toCandidatesCsv(results))
})

/** The sealed result document, in the shape the result endpoint serves. */
exports_.get('/api/batches/:id/elections/:eid/result.json', requireRole('officer'), async (c) => {
  const batchId = requireSession(c).batchId
  const electionId = c.req.param('eid')

  const sealed = await loadSealed(c.env.DB, batchId, electionId)
  if ('error' in sealed) return sealedError(c, sealed)

  const stored = await currentResult(c.env.DB, electionId)
  // An export copies the record. Only the officer, at /result, runs the count.
  if (!stored) {
    return c.json({ error: 'count the election before exporting its result', code: 'not_counted' }, 409)
  }

  c.header('content-disposition', `attachment; filename="result-${electionId}.json"`)
  return c.json(resultDocument(sealed, stored))
})
