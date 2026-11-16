/**
 * Election lifecycle: draft -> open -> closed. Closing is in close.ts.
 *
 * Candidates freeze at `open`. Every candidate mutation has the draft check
 * in its WHERE clause, so there is no check-then-act. Nothing in this file
 * returns a tally.
 */
import { Hono } from 'hono'
import type { Context } from 'hono'
import { z } from 'zod'
import { auditLogStatement, recordAudit } from '../db/audit.js'
import { requireRole, requireSession, type AuthedEnv } from '../middleware/requireRole.js'
import type { CandidateRow, ElectionRow } from '../db/types.js'
import type { Env } from '../index.js'
import { pathParam } from '../http/params.js'

const createElectionSchema = z.object({
  name: z.string().min(1).max(200),
  // Migration 0001's CHECK constraint enforces this. This gives the 400 a
  // message.
  seats: z.number().int().min(1).max(100),
})

const candidateSchema = z.object({ name: z.string().min(1).max(200) })

type PublicCandidate = Pick<CandidateRow, 'id' | 'name'>
type PublicElection = Pick<ElectionRow, 'id' | 'name' | 'seats' | 'status'> & {
  candidates: PublicCandidate[]
}

export const elections = new Hono<AuthedEnv>()

/** Public. Opened elections only: no draft, ballot, attendee or tally. */
const publicElections = new Hono<{ Bindings: Env }>()

/** A batch's elections with their candidates. A public caller must never pass 'draft'. */
async function listElections(
  db: D1Database,
  batchId: string,
  statuses: readonly ElectionRow['status'][],
): Promise<PublicElection[]> {
  const placeholders = statuses.map(() => '?').join(',')
  const [electionRows, candidateRows] = await Promise.all([
    db
      .prepare(
        `SELECT id, name, seats, status FROM election
          WHERE batch_id = ? AND status IN (${placeholders})
          ORDER BY rowid`,
      )
      .bind(batchId, ...statuses)
      .all<Pick<ElectionRow, 'id' | 'name' | 'seats' | 'status'>>(),
    db
      .prepare(
        `SELECT c.id, c.name, c.election_id FROM candidate c
           JOIN election e ON e.id = c.election_id
          WHERE e.batch_id = ? AND e.status IN (${placeholders})
          ORDER BY c.ordinal`,
      )
      .bind(batchId, ...statuses)
      .all<PublicCandidate & { election_id: string }>(),
  ])

  const byElection = new Map<string, PublicCandidate[]>()
  for (const row of candidateRows.results) {
    const list = byElection.get(row.election_id) ?? []
    list.push({ id: row.id, name: row.name })
    byElection.set(row.election_id, list)
  }

  return electionRows.results.map((e) => ({
    id: e.id,
    name: e.name,
    seats: e.seats,
    status: e.status,
    candidates: byElection.get(e.id) ?? [],
  }))
}

publicElections.get('/api/batches/:id/elections', async (c) =>
  c.json(await listElections(c.env.DB, c.req.param('id') ?? '', ['open', 'closed'])))

elections.route('/', publicElections)

/**
 * The officer's listing, drafts included. A separate authenticated path, not
 * a flag on the public route: a public response that varies by cookie can be
 * cached and served to anyone.
 */
elections.get('/api/batches/:id/officer/elections', requireRole('officer'), async (c) =>
  c.json(await listElections(c.env.DB, requireSession(c).batchId, ['draft', 'open', 'closed'])))

elections.post('/api/batches/:id/elections', requireRole('officer'), async (c) => {
  const batchId = requireSession(c).batchId
  const parsed = createElectionSchema.safeParse(await c.req.json().catch(() => undefined))
  if (!parsed.success) return c.json({ error: 'invalid request body' }, 400)

  const id = crypto.randomUUID()
  await c.env.DB.batch([
    c.env.DB
      .prepare(`INSERT INTO election (id, batch_id, name, seats, status) VALUES (?,?,?,?,'draft')`)
      .bind(id, batchId, parsed.data.name, parsed.data.seats),
    auditLogStatement(c.env.DB, { batchId, role: 'officer', action: 'election.create' }),
  ])

  return c.json({ id, name: parsed.data.name, seats: parsed.data.seats, status: 'draft' satisfies ElectionRow['status'] }, 201)
})

/**
 * 404 for no such election, 409 for one no longer in draft. Called only
 * after a conditional write changed zero rows, so it cannot race that write.
 */
async function explainNoChange(
  c: Context<AuthedEnv>,
  batchId: string,
  electionId: string,
): Promise<Response> {
  const row = await c.env.DB
    .prepare(`SELECT status FROM election WHERE id = ? AND batch_id = ?`)
    .bind(electionId, batchId)
    .first<Pick<ElectionRow, 'status'>>()
  if (!row) return c.json({ error: 'not found' }, 404)
  return c.json(
    {
      error: `candidates are frozen once voting is open (election is ${row.status})`,
      code: 'not_draft',
    },
    409,
  )
}

elections.post('/api/batches/:id/elections/:eid/candidates', requireRole('officer'), async (c) => {
  const batchId = requireSession(c).batchId
  const electionId = pathParam(c, 'eid')
  const parsed = candidateSchema.safeParse(await c.req.json().catch(() => undefined))
  if (!parsed.success) return c.json({ error: 'invalid request body' }, 400)

  const id = crypto.randomUUID()

  // The draft check and the `ordinal` are in the INSERT, so concurrent adds
  // cannot share a ballot position.
  const result = await c.env.DB
    .prepare(
      `INSERT INTO candidate (id, election_id, name, ordinal)
       SELECT ?1, ?2, ?3, (SELECT count(*) FROM candidate WHERE election_id = ?2)
        WHERE EXISTS (
          SELECT 1 FROM election
           WHERE id = ?2 AND batch_id = ?4 AND status = 'draft'
        )`,
    )
    .bind(id, electionId, parsed.data.name, batchId)
    .run()

  if (result.meta.changes === 0) return explainNoChange(c, batchId, electionId)

  await recordAudit(c.env.DB, { batchId, role: 'officer', action: 'candidate.add' })
  return c.json({ id, name: parsed.data.name }, 201)
})

elections.patch('/api/batches/:id/elections/:eid/candidates/:cid', requireRole('officer'), async (c) => {
  const batchId = requireSession(c).batchId
  const electionId = pathParam(c, 'eid')
  const candidateId = pathParam(c, 'cid')
  const parsed = candidateSchema.safeParse(await c.req.json().catch(() => undefined))
  if (!parsed.success) return c.json({ error: 'invalid request body' }, 400)

  const result = await c.env.DB
    .prepare(
      `UPDATE candidate SET name = ?1
        WHERE id = ?2 AND election_id = ?3
          AND (SELECT status FROM election WHERE id = ?3 AND batch_id = ?4) = 'draft'`,
    )
    .bind(parsed.data.name, candidateId, electionId, batchId)
    .run()

  if (result.meta.changes === 0) return explainNoChange(c, batchId, electionId)

  await recordAudit(c.env.DB, { batchId, role: 'officer', action: 'candidate.update' })
  return c.json({ id: candidateId, name: parsed.data.name })
})

elections.delete('/api/batches/:id/elections/:eid/candidates/:cid', requireRole('officer'), async (c) => {
  const batchId = requireSession(c).batchId
  const electionId = pathParam(c, 'eid')
  const candidateId = pathParam(c, 'cid')

  const result = await c.env.DB
    .prepare(
      `DELETE FROM candidate
        WHERE id = ?1 AND election_id = ?2
          AND (SELECT status FROM election WHERE id = ?2 AND batch_id = ?3) = 'draft'`,
    )
    .bind(candidateId, electionId, batchId)
    .run()

  if (result.meta.changes === 0) return explainNoChange(c, batchId, electionId)

  await recordAudit(c.env.DB, { batchId, role: 'officer', action: 'candidate.remove' })
  return c.body(null, 204)
})

elections.post('/api/batches/:id/elections/:eid/open', requireRole('officer'), async (c) => {
  const batchId = requireSession(c).batchId
  const electionId = pathParam(c, 'eid')

  // One conditional UPDATE holds every precondition: this batch's election,
  // still a draft, at least as many candidates as seats.
  const result = await c.env.DB
    .prepare(
      `UPDATE election SET status = 'open', opened_at = ?1
        WHERE id = ?2 AND batch_id = ?3 AND status = 'draft'
          AND (SELECT count(*) FROM candidate WHERE election_id = ?2) >= seats`,
    )
    .bind(Date.now(), electionId, batchId)
    .run()

  if (result.meta.changes === 0) {
    const row = await c.env.DB
      .prepare(
        `SELECT status, seats, (SELECT count(*) FROM candidate WHERE election_id = election.id) AS candidates
           FROM election WHERE id = ? AND batch_id = ?`,
      )
      .bind(electionId, batchId)
      .first<{ status: ElectionRow['status']; seats: number; candidates: number }>()
    if (!row) return c.json({ error: 'not found' }, 404)
    if (row.status !== 'draft') {
      return c.json({ error: `election is already ${row.status}`, code: 'not_draft' }, 409)
    }
    return c.json(
      {
        error: `an election needs at least as many candidates as seats (${row.candidates} candidate(s), ${row.seats} seat(s))`,
        code: 'not_enough_candidates',
      },
      409,
    )
  }

  const counts = await c.env.DB
    .prepare(`SELECT seats, (SELECT count(*) FROM candidate WHERE election_id = election.id) AS candidates FROM election WHERE id = ?`)
    .bind(electionId)
    .first<{ seats: number; candidates: number }>()

  await recordAudit(c.env.DB, {
    batchId,
    role: 'officer',
    action: 'election.open',
    detail: { kind: 'election_open', seats: counts?.seats ?? 0, candidates: counts?.candidates ?? 0 },
  })

  return c.json({ id: electionId, status: 'open' satisfies ElectionRow['status'] })
})

/**
 * Delete an election while it has no ballot (voided ballots count). An
 * officer can remove a mistake, never a vote.
 *
 * `election_seal` and `election_result` have no `ON DELETE CASCADE`. They
 * are deleted explicitly, and each statement has the no-ballot guard.
 */
elections.delete('/api/batches/:id/elections/:eid', requireRole('officer'), async (c) => {
  const batchId = requireSession(c).batchId
  const electionId = pathParam(c, 'eid')

  // Read for the audit detail only. Each statement below has its own guard.
  const before = await c.env.DB
    .prepare(`SELECT status FROM election WHERE id = ? AND batch_id = ?`)
    .bind(electionId, batchId)
    .first<Pick<ElectionRow, 'status'>>()
  if (!before) return c.json({ error: 'not found' }, 404)

  const NO_BALLOTS = `NOT EXISTS (SELECT 1 FROM ballot WHERE election_id = ?1)`

  const [, , deleted] = await c.env.DB.batch([
    c.env.DB
      .prepare(`DELETE FROM election_result WHERE election_id = ?1 AND ${NO_BALLOTS}`)
      .bind(electionId),
    c.env.DB
      .prepare(`DELETE FROM election_seal WHERE election_id = ?1 AND ${NO_BALLOTS}`)
      .bind(electionId),
    // Candidates cascade from this one. The guard means no ballots or receipts exist.
    c.env.DB
      .prepare(`DELETE FROM election WHERE id = ?1 AND batch_id = ?2 AND ${NO_BALLOTS}`)
      .bind(electionId, batchId),
  ])

  if ((deleted?.meta.changes ?? 0) === 0) {
    const ballots = await c.env.DB
      .prepare(`SELECT count(*) AS n FROM ballot WHERE election_id = ?`)
      .bind(electionId)
      .first<{ n: number }>()
    return c.json(
      {
        error:
          `this election has ${ballots?.n ?? 0} ballot(s) in it and cannot be deleted. `
          + 'A ballot that has been cast is never deleted.',
        code: 'has_ballots',
      },
      409,
    )
  }

  await recordAudit(c.env.DB, {
    batchId,
    role: 'officer',
    action: 'election.delete',
    detail: { kind: 'election_delete', status: before.status },
  })

  return c.body(null, 204)
})
