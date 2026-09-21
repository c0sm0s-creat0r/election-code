/**
 * Election lifecycle: draft -> open -> closed (closing is Plan 2c).
 *
 * Two rules carry the weight here, both from spec §4, and both are enforced by
 * the *database* rather than by a check-then-act in this file:
 *
 * **Candidates freeze at `open`.** The legacy `add_candidate` worked at any
 * time. Adding a candidate after fifty ballots means those fifty voters never
 * had the chance to rank them, and their ballots are silently incomparable
 * with every later one. Every candidate mutation therefore carries
 * `AND (SELECT status FROM election ...) = 'draft'` in its own WHERE clause: a
 * request that arrives while the election is being opened changes nothing.
 *
 * **No tally exists until `closed`.** Nothing in this file returns a count,
 * and the public listing returns five fields. The legacy hole spec §6 records
 * was a public route that returned every ballot and every attendee's name and
 * USU id.
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
  // The CHECK constraint in 0001 says the same thing. Both: the constraint is
  // the guarantee, this is the 400 that explains it.
  seats: z.number().int().min(1).max(100),
})

const candidateSchema = z.object({ name: z.string().min(1).max(200) })

type PublicCandidate = Pick<CandidateRow, 'id' | 'name'>
type PublicElection = Pick<ElectionRow, 'id' | 'name' | 'seats' | 'status'> & {
  candidates: PublicCandidate[]
}

export const elections = new Hono<AuthedEnv>()

/**
 * Public. Returns `{id, name, seats, status, candidates}` and nothing else —
 * never a ballot, never an attendee, never a tally — and only for elections
 * that have been opened. A draft is not yet a fact about the world.
 */
const publicElections = new Hono<{ Bindings: Env }>()

/**
 * Lists a batch's elections with their candidates. `statuses` is what separates
 * the public listing from the officer's: the public one must never show a draft,
 * because a draft is not yet a fact about the world.
 */
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
 * The officer's own listing, drafts included.
 *
 * A separate authenticated path rather than a flag on the public route: a public
 * response whose body changes with a cookie is a caching hazard — a shared cache
 * can serve a draft-bearing copy to anyone. Without this an officer who reloads
 * the page cannot find the election they just created.
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
 * Distinguishes "no such election in this batch" (404) from "the election is
 * no longer in draft" (409). Called only after a conditional write has already
 * reported zero rows, so it never races the write it explains.
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

  // The draft check is part of the INSERT, not a step before it. `ordinal` is
  // derived in the same statement so two candidates added concurrently cannot
  // land on the same ballot position.
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

  // One conditional UPDATE carries every precondition: the election is this
  // batch's, it is still a draft, and it has at least as many candidates as
  // seats. `minimumPreferences` is Math.max(1, ...) so the library is safe
  // standalone, but an election with no candidates must never open — a voter
  // would be handed a ballot they cannot fill in.
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
