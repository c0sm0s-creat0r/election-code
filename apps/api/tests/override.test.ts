import { describe, it, expect, beforeEach } from 'vitest'
import { SELF, env } from 'cloudflare:test'
import { setUp, submitBallot, JSON_HEADERS, type Fixture } from './helpers.js'

let f: Fixture

/**
 * Two ballots, one seat, one each: an `exclusion` tie settled by seeded draw.
 * `resolved_id` names the candidate excluded, so overriding it flips the winner.
 */
beforeEach(async () => {
  f = await setUp(['2400001', '2400002'])
  const { a, b } = f.candidateIds
  await submitBallot(f.batchId, f.electionId, f.voterCookies['2400001']!, [a, b])
  await submitBallot(f.batchId, f.electionId, f.voterCookies['2400002']!, [b, a])
})

const close = () =>
  SELF.fetch(`https://example.com/api/batches/${f.batchId}/elections/${f.electionId}/close`, {
    method: 'POST', headers: { cookie: f.officerCookie },
  })

const getResult = () =>
  SELF.fetch(`https://example.com/api/batches/${f.batchId}/elections/${f.electionId}/result`, {
    headers: { cookie: f.officerCookie },
  })

const override = (body: Record<string, unknown>, cookie = f.officerCookie) =>
  SELF.fetch(`https://example.com/api/batches/${f.batchId}/elections/${f.electionId}/result/override`, {
    method: 'POST', headers: { ...JSON_HEADERS, cookie }, body: JSON.stringify(body),
  })

type Document = {
  overridden: boolean
  winners: { id: string }[]
  tie_breaks: { id: string; kind: string; method: string; resolved: string; candidates: string[]; reason: string | null }[]
}

/** Close, count, and return the first result document. */
const closeAndCount = async (): Promise<Document> => {
  await close()
  return await (await getResult()).json() as Document
}

/** The other side of the draw. */
const otherSide = (doc: Document) => {
  const tb = doc.tie_breaks[0]!
  return tb.candidates.find((id) => id !== tb.resolved)!
}

describe('tie-break override', () => {
  it('requires an officer session', async () => {
    await closeAndCount()
    expect((await override({ tie_break_id: 'tb-1', resolved_id: 'a', reason: 'r' }, '')).status).toBe(401)
  })

  it('refuses a door session', async () => {
    await closeAndCount()
    expect((await override({ tie_break_id: 'tb-1', resolved_id: 'a', reason: 'r' }, f.doorCookie)).status).toBe(403)
  })

  it('refuses an override before the election is closed', async () => {
    expect((await override({ tie_break_id: 'tb-1', resolved_id: 'a', reason: 'r' })).status).toBe(409)
  })

  it('refuses an override before a count exists', async () => {
    await close()
    expect((await override({ tie_break_id: 'tb-1', resolved_id: 'a', reason: 'r' })).status).toBe(409)
  })

  it('requires a reason', async () => {
    const doc = await closeAndCount()
    expect((await override({ tie_break_id: 'tb-1', resolved_id: otherSide(doc) })).status).toBe(400)
  })

  it('rejects an empty reason', async () => {
    const doc = await closeAndCount()
    expect((await override({ tie_break_id: 'tb-1', resolved_id: otherSide(doc), reason: '   ' })).status).toBe(400)
  })

  it('rejects an unknown tie_break_id', async () => {
    const doc = await closeAndCount()
    expect((await override({ tie_break_id: 'tb-99', resolved_id: otherSide(doc), reason: 'r' })).status).toBe(400)
  })

  it('rejects a candidate who was not party to that tie', async () => {
    await closeAndCount()
    expect((await override({ tie_break_id: 'tb-1', resolved_id: crypto.randomUUID(), reason: 'r' })).status).toBe(400)
  })

  it('writes a NEW result row superseding the previous one', async () => {
    const doc = await closeAndCount()
    const res = await override({ tie_break_id: 'tb-1', resolved_id: otherSide(doc), reason: 'Drew lots at the AGM' })
    expect(res.status).toBe(200)
    const rows = await env.DB
      .prepare('SELECT id, supersedes, overridden FROM election_result WHERE election_id = ? ORDER BY id')
      .bind(f.electionId).all<{ id: number; supersedes: number | null; overridden: number }>()
    expect(rows.results).toHaveLength(2)
    expect(rows.results[1]!.supersedes).toBe(rows.results[0]!.id)
    expect(rows.results[1]!.overridden).toBe(1)
  })

  it('NEVER deletes the superseded result', async () => {
    const doc = await closeAndCount()
    await override({ tie_break_id: 'tb-1', resolved_id: otherSide(doc), reason: 'r' })
    const row = await env.DB.prepare('SELECT count(*) c FROM election_result').first<{ c: number }>()
    expect(row!.c).toBe(2)
  })

  it('CHANGES THE WINNER — resolved_id for an exclusion tie is who goes OUT', async () => {
    const before = await closeAndCount()
    const winnerBefore = before.winners[0]!.id
    // the tie resolved to exclude `resolved`; excluding the other candidate
    // must elect the one previously excluded
    await override({ tie_break_id: 'tb-1', resolved_id: otherSide(before), reason: 'Returning officer drew lots' })
    const after = await (await getResult()).json() as Document
    expect(after.winners[0]!.id).not.toBe(winnerBefore)
  })

  it("carries the officer's reason into the result document", async () => {
    const doc = await closeAndCount()
    await override({ tie_break_id: 'tb-1', resolved_id: otherSide(doc), reason: 'Returning officer drew lots' })
    const after = await (await getResult()).json() as Document
    const tb = after.tie_breaks.find((t) => t.method === 'officer_override')
    expect(tb!.reason).toBe('Returning officer drew lots')
  })

  it('returns the superseding result from the result endpoint', async () => {
    const doc = await closeAndCount()
    await override({ tie_break_id: 'tb-1', resolved_id: otherSide(doc), reason: 'r' })
    const after = await (await getResult()).json() as Document
    expect(after.overridden).toBe(true)
  })

  it('reports the tie kind, so a UI can label the control truthfully', async () => {
    const doc = await closeAndCount()
    expect(doc.tie_breaks[0]!.kind).toBe('exclusion')
  })

  it('keeps an earlier override when a later one is applied', async () => {
    // a new override must keep the officer's earlier one
    const doc = await closeAndCount()
    const first = otherSide(doc)
    await override({ tie_break_id: 'tb-1', resolved_id: first, reason: 'first decision' })
    const second = await (await getResult()).json() as Document
    // resolve the same tie the other way, then check the reasons
    await override({ tie_break_id: 'tb-1', resolved_id: second.tie_breaks[0]!.candidates[0]!, reason: 'second decision' })
    const third = await (await getResult()).json() as Document
    const tb = third.tie_breaks.find((t) => t.method === 'officer_override')
    expect(tb!.reason).toBe('second decision')
    const rows = await env.DB.prepare('SELECT count(*) c FROM election_result').first<{ c: number }>()
    expect(rows!.c).toBe(3)
  })

  it('records the override in the audit log with its reason and no identities', async () => {
    const doc = await closeAndCount()
    await override({ tie_break_id: 'tb-1', resolved_id: otherSide(doc), reason: 'Returning officer drew lots' })
    const row = await env.DB.prepare(`SELECT detail FROM audit_log WHERE action = 'result.override'`)
      .first<{ detail: string }>()
    expect(JSON.parse(row!.detail)).toMatchObject({
      kind: 'tie_override', tieBreakId: 'tb-1', reason: 'Returning officer drew lots',
    })
    for (const usuId of Object.keys(f.voterCookies)) expect(row!.detail).not.toContain(usuId)
  })
})
