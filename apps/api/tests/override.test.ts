import { describe, it, expect, beforeEach } from 'vitest'
import { env } from 'cloudflare:test'
import { api, cast, closeElection, countOf, getResult, setUp, type Fixture } from './helpers.js'

let f: Fixture

/**
 * Two ballots, one seat, one each: an `exclusion` tie settled by seeded draw.
 * `resolved_id` names the candidate excluded, so overriding it flips the winner.
 */
beforeEach(async () => {
  f = await setUp(['2400001', '2400002'])
  await cast(f, '2400001', 'a', 'b')
  await cast(f, '2400002', 'b', 'a')
})

const override = (body: Record<string, unknown>) =>
  api('POST', `/batches/${f.batchId}/elections/${f.electionId}/result/override`, f.officerCookie, body)

type Document = {
  overridden: boolean
  winners: { id: string }[]
  tie_breaks: { id: string; method: string; resolved: string; candidates: string[]; reason: string | null }[]
}
const result = async () => await (await getResult(f)).json() as Document

/** Close, count, and return the first result document. */
const closeAndCount = async (): Promise<Document> => {
  await closeElection(f)
  return result()
}

/** The other side of the draw. */
const otherSide = (doc: Document) => {
  const tb = doc.tie_breaks[0]!
  return tb.candidates.find((id) => id !== tb.resolved)!
}

describe('tie-break override', () => {
  it('refuses an override before the election is closed, and before a count exists', async () => {
    const body = { tie_break_id: 'tb-1', resolved_id: f.candidateIds.a, reason: 'r' }
    expect((await override(body)).status).toBe(409)
    await closeElection(f)
    expect((await override(body)).status).toBe(409)
  })

  it.each<[string, (other: string) => Record<string, unknown>]>([
    ['no reason', (other) => ({ tie_break_id: 'tb-1', resolved_id: other })],
    ['an empty reason', (other) => ({ tie_break_id: 'tb-1', resolved_id: other, reason: '   ' })],
    ['an unknown tie_break_id', (other) => ({ tie_break_id: 'tb-99', resolved_id: other, reason: 'r' })],
    ['a candidate who was not party to that tie', () =>
      ({ tie_break_id: 'tb-1', resolved_id: crypto.randomUUID(), reason: 'r' })],
  ])('rejects %s', async (_label, body) => {
    const doc = await closeAndCount()
    expect((await override(body(otherSide(doc)))).status).toBe(400)
    expect(await countOf('election_result')).toBe(1)
  })

  it('writes a NEW result that supersedes the old one, changes the winner and carries the reason', async () => {
    const before = await closeAndCount()
    // the tie resolved to exclude `resolved`; excluding the other candidate
    // must elect the one previously excluded
    const res = await override({ tie_break_id: 'tb-1', resolved_id: otherSide(before), reason: 'Returning officer drew lots' })
    expect(res.status).toBe(200)

    const after = await result()
    expect(after.overridden).toBe(true)
    expect(after.winners[0]!.id).not.toBe(before.winners[0]!.id)
    expect(after.tie_breaks.find((t) => t.method === 'officer_override')!.reason).toBe('Returning officer drew lots')

    // the superseded result is never deleted
    const rows = await env.DB
      .prepare('SELECT id, supersedes, overridden FROM election_result WHERE election_id = ? ORDER BY id')
      .bind(f.electionId).all<{ id: number; supersedes: number | null; overridden: number }>()
    expect(rows.results).toMatchObject([{ supersedes: null, overridden: 0 }, { supersedes: rows.results[0]!.id, overridden: 1 }])

    const audit = await env.DB.prepare(`SELECT detail FROM audit_log WHERE action = 'result.override'`)
      .first<{ detail: string }>()
    expect(JSON.parse(audit!.detail)).toEqual({ kind: 'tie_override', tieBreakId: 'tb-1', reason: 'Returning officer drew lots' })
  })

  it('lets a later override replace an earlier one, keeping every result row', async () => {
    const doc = await closeAndCount()
    await override({ tie_break_id: 'tb-1', resolved_id: otherSide(doc), reason: 'first decision' })
    const second = await result()
    await override({ tie_break_id: 'tb-1', resolved_id: second.tie_breaks[0]!.candidates[0]!, reason: 'second decision' })
    const third = await result()
    expect(third.tie_breaks.find((t) => t.method === 'officer_override')!.reason).toBe('second decision')
    expect(await countOf('election_result')).toBe(3)
  })
})
