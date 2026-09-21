# apps/api Result Path Implementation Plan (Plan 2c)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn a finished ballot box into a defensible result — seal it, count it, let an officer override a tie-break on the record, and export everything a disputing party would need to check the work themselves.

**Architecture:** Hono on Workers over Plans 2a and 2b. Counting is delegated entirely to `@election/core`; this plan adds no election logic of its own. R2 for logos, D1 for everything else.

**Tech Stack:** Hono, Zod, `@election/core`, Cloudflare D1 + KV + R2, Vitest with `@cloudflare/vitest-pool-workers`.

**Spec:** `docs/superpowers/specs/2026-09-16-election-code-rewrite-design.md` — §2 (seal and result tables), §3 (tie-breaks), §4 (lifecycle), §5 (API surface), §6 (security posture)
**Handoff — READ §6b BEFORE TASK 1:** `docs/superpowers/HANDOFF.md`

**Plan 2c of 3 for `apps/api`.** 2a (foundation) is complete at 111/111. 2b (voting path) is written, not executed — **this plan depends on it**, since there is nothing to seal until ballots exist.

## Global Constraints

- **`apps/api` runtime dependencies stay exactly `hono`, `zod`, `@election/core`.** R2 and KV bindings are configuration, not dependencies.
- **`packages/core` keeps zero runtime dependencies.** Task 4 modifies it; that limit still binds.
- **No ORM.** D1 prepared statements only. `0001_initial.sql` is **immutable**; schema changes go in a new numbered migration.
- TypeScript `strict`, `noUncheckedIndexedAccess`, `noUnusedLocals`. No `any` in exported signatures.
- **Every gated route is `/api/batches/:id/...`** — `requireRole` binds the literal param name `id`.
- **`AuditEntry.detail` is an allow-list.** Never a usu_id, never a ballot id, never a preference list.
- **Write `ORDER BY id` explicitly** wherever ballots are serialised. `ballot` is `WITHOUT ROWID`, so physical order is *already* UUID order and it is tempting to omit it — but spec §2 defines the digest as sorted by `id` ascending, and that must come from the query, not from a storage detail that a later migration could change.
- No password, hash, token or secret in any response body, error or log line.
- TDD throughout: failing test, watch it fail, implement, commit.

---

### Task 1: Close and seal

**Files:**
- Create: `apps/api/src/routes/close.ts`, `apps/api/src/lib/seal.ts`
- Modify: `apps/api/src/index.ts`, `apps/api/src/db/audit.ts`
- Test: `apps/api/tests/close.test.ts`

**Interfaces:**
- Consumes: `requireRole('officer')`, `recordAudit`, `auditLogStatement`
- Produces: `sealSerialisation(rows): string`, `ballotsSha256(rows): Promise<string>`; `POST /api/batches/:id/elections/:eid/close`

**Closing is irreversible, and that is the point.** Spec §4: an officer who can reopen an election can watch the result develop and choose when to stop, which makes every other control decorative.

**Why close and seal are two statements, not one.** The digest is computed over the ballots, so it has to read them — and reading then writing is a race while the election is still open. The transition to `closed` is what makes the read safe: 2b's ballot insert carries `AND e.status = 'open'` in its `EXISTS` clause, so once the status flips, no further ballot can be written. So: flip the status first, *then* read and seal.

That leaves a window where an election is closed but unsealed. **Handle it rather than hoping:** if the endpoint is called on an election that is already `closed` and has no `election_seal` row, it proceeds to seal. That makes the operation retryable without permitting a re-close.

**The digest, exactly** (spec §2): SHA-256 over every ballot row for the election, **sorted by `id` ascending**, each rendered `id|preferences|voided` and joined with `\n`. `preferences` is the JSON string as stored; `voided` is `0` or `1`. **Voided ballots are included** — the seal covers what is in the box, and a voided ballot is still in the box.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, beforeEach } from 'vitest'
import { SELF, env, applyD1Migrations } from 'cloudflare:test'
// setup as in Plan 2b: batch, officer cookie, roll, checked-in voters,
// an open election with candidates a and b, and three cast ballots.

describe('close and seal', () => {
  it('requires an officer session', async () => {
    expect((await close('')).status).toBe(401)
  })

  it('refuses to close a draft election', async () => {
    expect((await closeElection(draftId)).status).toBe(409)
  })

  it('closes an open election', async () => {
    const res = await close()
    expect(res.status).toBe(200)
    const row = await env.DB.prepare('SELECT status, closed_at FROM election WHERE id = ?').bind(eid).first<{ status: string; closed_at: number }>()
    expect(row!.status).toBe('closed')
    expect(row!.closed_at).toBeGreaterThan(0)
  })

  it('writes a seal recording the ballot count and digest', async () => {
    await close()
    const row = await env.DB.prepare('SELECT ballot_count, ballots_sha256 FROM election_seal WHERE election_id = ?').bind(eid).first<{ ballot_count: number; ballots_sha256: string }>()
    expect(row!.ballot_count).toBe(3)
    expect(row!.ballots_sha256).toMatch(/^[0-9a-f]{64}$/)
  })

  it('counts voided ballots in the seal — they are still in the box', async () => {
    await voidOneBallot()
    await close()
    const row = await env.DB.prepare('SELECT ballot_count FROM election_seal').first<{ ballot_count: number }>()
    expect(row!.ballot_count).toBe(3)
  })

  it('REFUSES A SECOND CLOSE', async () => {
    await close()
    expect((await close()).status).toBe(409)
  })

  it('never overwrites an existing seal', async () => {
    await close()
    const before = await env.DB.prepare('SELECT ballots_sha256 FROM election_seal').first<{ ballots_sha256: string }>()
    await close()
    const after = await env.DB.prepare('SELECT ballots_sha256 FROM election_seal').first<{ ballots_sha256: string }>()
    expect(after!.ballots_sha256).toBe(before!.ballots_sha256)
  })

  it('seals a closed-but-unsealed election, so the operation is retryable', async () => {
    await env.DB.prepare(`UPDATE election SET status='closed', closed_at=? WHERE id=?`).bind(Date.now(), eid).run()
    const res = await close()
    expect(res.status).toBe(200)
    const row = await env.DB.prepare('SELECT count(*) c FROM election_seal').first<{ c: number }>()
    expect(row!.c).toBe(1)
  })

  it('REFUSES A BALLOT once closed', async () => {
    await close()
    expect((await submit(['a', 'b'])).status).toBe(409)
  })

  it('produces a digest independent of insertion order', async () => {
    // the digest is defined as sorted by id; WITHOUT ROWID means physical
    // order is already UUID order, so this pins the ORDER BY rather than the
    // storage detail
    await close()
    const sealed = await env.DB.prepare('SELECT ballots_sha256 FROM election_seal').first<{ ballots_sha256: string }>()
    const rows = await env.DB.prepare('SELECT id, preferences, voided FROM ballot WHERE election_id = ? ORDER BY id').bind(eid).all<{ id: string; preferences: string; voided: number }>()
    const canonical = rows.results.map((r) => `${r.id}|${r.preferences}|${r.voided}`).join('\n')
    const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical)))]
      .map((b) => b.toString(16).padStart(2, '0')).join('')
    expect(sealed!.ballots_sha256).toBe(digest)
  })

  it('records an audit row with the ballot count and no identities', async () => {
    await close()
    const row = await env.DB.prepare(`SELECT detail FROM audit_log WHERE action = 'election.close'`).first<{ detail: string }>()
    expect(JSON.parse(row!.detail)).toMatchObject({ kind: 'election_close', ballotCount: 3 })
    expect(row!.detail).not.toMatch(/\d{7}/)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run -w @election/api test -- close`
Expected: FAIL — route not registered

- [ ] **Step 3: Write minimal implementation**

`apps/api/src/lib/seal.ts`:

```ts
export type SealableBallot = { id: string; preferences: string; voided: number }

/**
 * Spec §2: every ballot row for the election, sorted by id ascending, each
 * rendered `id|preferences|voided`, joined with newlines.
 *
 * Voided ballots are included. The seal covers what is in the box, and a
 * voided ballot is still in the box — excluding them would let a void after
 * the fact change the digest without changing the ballots.
 *
 * The caller supplies rows already ordered by the query's explicit ORDER BY
 * id. Do not rely on `ballot` being WITHOUT ROWID for that ordering.
 */
export const sealSerialisation = (rows: SealableBallot[]): string =>
  rows.map((r) => `${r.id}|${r.preferences}|${r.voided}`).join('\n')

export async function ballotsSha256(rows: SealableBallot[]): Promise<string> {
  const bytes = new TextEncoder().encode(sealSerialisation(rows))
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}
```

Handler order:

1. `requireRole('officer')`. Load the election; 404 if absent or not in this batch.
2. If `status === 'draft'` → 409.
3. If `status === 'open'`: `UPDATE election SET status='closed', closed_at=? WHERE id=? AND batch_id=? AND status='open'`. `changes === 0` → 409 (someone else closed it first).
4. If `status === 'closed'` and a seal already exists → 409. If closed with no seal, fall through and seal.
5. `SELECT id, preferences, voided FROM ballot WHERE election_id = ? ORDER BY id` — **explicit `ORDER BY`**.
6. `DB.batch([insertSeal, clearLiveReceiptLinks, auditLogStatement])`, with
   `INSERT INTO election_seal ... ON CONFLICT(election_id) DO NOTHING` so a retry cannot overwrite.
7. Return `200 { closed_at, ballot_count, ballots_sha256 }`.

**`clearLiveReceiptLinks` is not optional — see HANDOFF §2.** Plan 2b added
`vote_receipt.live_receipt_hash` so a void can find the mark-off to clear, and while it is set it is
a join from a `usu_id` to that ballot's preferences. After close nothing can be voided, so the
column has no remaining purpose:

```sql
UPDATE vote_receipt SET live_receipt_hash = NULL WHERE election_id = ?
```

In the **same transaction** as the seal. The exposure was accepted as a bounded one; this statement
is what bounds it.

Add an `election_close` variant to `AuditDetail` if absent.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run -w @election/api test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/api
git commit -m "feat(api): irreversible close with a retryable seal"
```

---

### Task 2: Count the sealed ballots

**Files:**
- Create: `apps/api/src/routes/result.ts`
- Modify: `apps/api/src/index.ts`, `apps/api/src/db/audit.ts`
- Test: `apps/api/tests/result.test.ts`

**Interfaces:**
- Consumes: `count` from `@election/core`, `requireRole('officer')`
- Produces: `GET /api/batches/:id/elections/:eid/result`

**No tally exists before `closed`.** Spec §4. This endpoint must 409 on a draft or open election — not return a partial count, not return an empty result.

**Voided ballots are sealed but not counted.** They stay in the table so the digest covers them; they are excluded from the count. That distinction is the whole reason `ballot.voided` exists.

**The count is computed once and stored.** Subsequent requests return the stored `election_result` row. Recomputing on every request would be wasteful and, worse, would make the result depend on code rather than on a record — an override in Task 3 must produce a *new versioned row*, not silently change an old answer.

**This plan adds no election logic.** `@election/core` does the counting. If a result looks wrong, the bug is there, and there is a differential test and 135 tests waiting for it.

- [ ] **Step 1: Write the failing test**

```ts
describe('result', () => {
  it('requires an officer session', async () => {
    expect((await getResult('')).status).toBe(401)
  })

  it('REFUSES a result while the election is open', async () => {
    expect((await getResult()).status).toBe(409)
  })

  it('refuses a result for a draft election', async () => {
    expect((await getResultFor(draftId)).status).toBe(409)
  })

  it('returns the count once closed', async () => {
    await close()
    const res = await getResult()
    expect(res.status).toBe(200)
    const body = await res.json() as { quota: string; winners: { id: string }[]; rounds: unknown[] }
    expect(body.quota).toBe('2.00000')     // 3 ballots, 1 seat
    expect(body.winners).toHaveLength(1)
    expect(body.rounds.length).toBeGreaterThan(0)
  })

  it('stores the result rather than recomputing it', async () => {
    await close()
    await getResult()
    await getResult()
    const row = await env.DB.prepare('SELECT count(*) c FROM election_result WHERE election_id = ?').bind(eid).first<{ c: number }>()
    expect(row!.c).toBe(1)
  })

  it('EXCLUDES voided ballots from the count but keeps them in the seal', async () => {
    await voidOneBallot()
    await close()
    const seal = await env.DB.prepare('SELECT ballot_count FROM election_seal').first<{ ballot_count: number }>()
    expect(seal!.ballot_count).toBe(3)
    const body = await (await getResult()).json() as { quota: string }
    expect(body.quota).toBe('2.00000')     // 2 counted ballots, 1 seat -> floor(2/2)+1
  })

  it('seeds tie-breaks from the sealed digest, so a draw is reproducible', async () => {
    await close()
    const seal = await env.DB.prepare('SELECT ballots_sha256 FROM election_seal').first<{ ballots_sha256: string }>()
    const body = await (await getResult()).json() as { tie_breaks: { seed: string | null }[] }
    for (const t of body.tie_breaks) {
      if (t.seed) expect(t.seed).not.toBe(seal!.ballots_sha256)  // derived from it, not equal to it
    }
    // and the same request twice gives an identical result
    expect(await (await getResult()).text()).toBe(await (await getResult()).text())
  })

  it('records an audit row with round and winner counts only', async () => {
    await close()
    await getResult()
    const row = await env.DB.prepare(`SELECT detail FROM audit_log WHERE action = 'election.count'`).first<{ detail: string }>()
    expect(JSON.parse(row!.detail)).toMatchObject({ kind: 'count' })
    expect(row!.detail).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}/)   // no ballot ids
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run -w @election/api test -- result`
Expected: FAIL — route not registered

- [ ] **Step 3: Write minimal implementation**

1. `requireRole('officer')`. 409 unless `status === 'closed'` and a seal exists.
2. If an `election_result` row exists with no superseding row, return it.
3. Otherwise: load candidates (`ORDER BY ordinal`) and **non-voided** ballots (`WHERE voided = 0 ORDER BY id`).
4. `await count({ candidates, ballots, seats, electionId, ballotsSha256 })` — `ballotsSha256` comes from the seal, which is what makes a seeded draw reproducible by anyone holding the export.
5. `INSERT INTO election_result (election_id, computed_at, quota, rounds, winners, tie_breaks, overridden, supersedes) VALUES (?,?,?,?,?,?,0,NULL)`, batched with the audit statement.

   **`quota` needs a column, added by `migrations/0003_election_result_quota.sql`.** The response
   carries `quota` and a second request must be byte-identical to the first, but it is served from
   the stored row — and quota cannot be recomputed from what 0001 stores: `Round` does not carry it,
   and the seal's `ballot_count` includes voided ballots, which the count excludes. `NOT NULL DEFAULT
   ''` because D1 requires a default when adding a NOT NULL column to an existing table; no row can
   observe it, since this task is the first code that writes `election_result` at all.
6. Return the result.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run -w @election/api test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/api
git commit -m "feat(api): count sealed ballots via @election/core, stored once"
```

---

### Task 3: Tie-break override

**Files:**
- Create: `apps/api/src/routes/override.ts`
- Modify: `apps/api/src/index.ts`, `apps/api/src/db/audit.ts`, and **the spec's §5 field name**
- Test: `apps/api/tests/override.test.ts`

**Interfaces:**
- Consumes: `count` with `overrides`, `requireRole('officer')`
- Produces: `POST /api/batches/:id/elections/:eid/result/override`

**The field is `resolved_id`, not `winner_id`.** Spec §5 currently names it `winner_id`, and that name is a trap: for `kind: 'exclusion'` the id in a `TieBreakRecord.resolved` is the candidate **excluded**, not the one who survives. A UI built from the spec saying "pick the winner" would collect the exact opposite of the officer's intent, silently, and produce a result that looks correct. **Rename the field in spec §5 as part of this task**, and have the API echo the tie's `kind` so a frontend can label the control truthfully.

**An override never edits the old result.** It writes a **new** `election_result` row with `supersedes` pointing at the previous one and `overridden = 1`. Spec §2: "The officer changed the tie-break and the winner changed" must remain a visible fact with both counts attached.

**A reason is required** and must reach `TieBreakRecord.reason`. `CountInput.overrides` is `Record<string, { candidateId: string; reason: string }>` — the shape exists for this.

- [ ] **Step 1: Write the failing test**

```ts
describe('tie-break override', () => {
  it('requires an officer session', async () => {
    expect((await override('', {})).status).toBe(401)
  })

  it('refuses an override before the election is closed', async () => {
    expect((await override(officerCookie, { tie_break_id: 'tb-1', resolved_id: 'a', reason: 'r' })).status).toBe(409)
  })

  it('requires a reason', async () => {
    await closeAndCount()
    expect((await override(officerCookie, { tie_break_id: 'tb-1', resolved_id: 'a' })).status).toBe(400)
  })

  it('rejects an empty reason', async () => {
    await closeAndCount()
    expect((await override(officerCookie, { tie_break_id: 'tb-1', resolved_id: 'a', reason: '   ' })).status).toBe(400)
  })

  it('rejects an unknown tie_break_id', async () => {
    await closeAndCount()
    expect((await override(officerCookie, { tie_break_id: 'tb-99', resolved_id: 'a', reason: 'r' })).status).toBe(400)
  })

  it('rejects a candidate who was not party to that tie', async () => {
    await closeAndCount()
    expect((await override(officerCookie, { tie_break_id: 'tb-1', resolved_id: 'zzz', reason: 'r' })).status).toBe(400)
  })

  it('writes a NEW result row superseding the previous one', async () => {
    const before = await closeAndCount()
    await override(officerCookie, { tie_break_id: 'tb-1', resolved_id: theOtherCandidate(before), reason: 'Drew lots at the AGM' })
    const rows = await env.DB.prepare('SELECT id, supersedes, overridden FROM election_result WHERE election_id = ? ORDER BY id').bind(eid).all<{ id: number; supersedes: number | null; overridden: number }>()
    expect(rows.results).toHaveLength(2)
    expect(rows.results[1]!.supersedes).toBe(rows.results[0]!.id)
    expect(rows.results[1]!.overridden).toBe(1)
  })

  it('NEVER deletes the superseded result', async () => {
    const before = await closeAndCount()
    await override(officerCookie, { tie_break_id: 'tb-1', resolved_id: theOtherCandidate(before), reason: 'r' })
    const row = await env.DB.prepare('SELECT count(*) c FROM election_result').first<{ c: number }>()
    expect(row!.c).toBe(2)
  })

  it("carries the officer's reason into the result document", async () => {
    const before = await closeAndCount()
    await override(officerCookie, { tie_break_id: 'tb-1', resolved_id: theOtherCandidate(before), reason: 'Returning officer drew lots' })
    const body = await (await getResult()).json() as { tie_breaks: { method: string; reason: string | null }[] }
    const tb = body.tie_breaks.find((t) => t.method === 'officer_override')
    expect(tb!.reason).toBe('Returning officer drew lots')
  })

  it('returns the superseding result from the result endpoint', async () => {
    const before = await closeAndCount()
    const other = theOtherCandidate(before)
    await override(officerCookie, { tie_break_id: 'tb-1', resolved_id: other, reason: 'r' })
    const after = await (await getResult()).json() as { overridden: boolean }
    expect(after.overridden).toBe(true)
  })

  it('reports the tie kind, so a UI can label the control truthfully', async () => {
    await closeAndCount()
    const body = await (await getResult()).json() as { tie_breaks: { id: string; kind: string }[] }
    expect(['exclusion', 'election_order']).toContain(body.tie_breaks[0]!.kind)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run -w @election/api test -- override`
Expected: FAIL — route not registered

- [ ] **Step 3: Write minimal implementation**

1. `requireRole('officer')`. 409 unless closed, sealed and already counted.
2. Zod: `{ tie_break_id: string, resolved_id: string, reason: string }` with `reason` trimmed and non-empty.
3. Load the current result's `tie_breaks`. Reject an unknown `tie_break_id` (400) or a `resolved_id` not in that tie's `candidates` (400) — `count` throws on both, but answering 400 here is clearer than a 500 from a library.
4. Accumulate **all** overrides recorded so far on this election plus the new one, and re-run `count` with them. An override must not silently discard an earlier one.
5. `INSERT INTO election_result (... overridden, supersedes) VALUES (..., 1, ?)`, batched with the audit statement using the `tie_override` detail variant.
6. Amend spec §5: `winner_id` → `resolved_id`, with a sentence stating that for an exclusion tie the id is the candidate to exclude.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run -w @election/api test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/api docs/superpowers/specs
git commit -m "feat(api): versioned tie-break override, and rename winner_id to resolved_id"
```

---

### Task 4 (`packages/core`): carry `voided` through the ballot CSV

**Files:**
- Modify: `packages/core/src/recount.ts`, `packages/core/src/index.ts` if the export list changes
- Test: `packages/core/tests/recount.test.ts`

**Interfaces:**
- Produces: `toBallotsCsv` emitting `ballot_id,preferences,voided`; `recount` accepting it

**Why this is in scope, and why it is its own task.** Spec §2 currently admits a gap:

> **It is not currently reproducible from the exported ballot CSV.** `toBallotsCsv` emits `ballot_id,preferences` only — no `voided` column — so a recount can recompute the count but cannot verify that the ballots it was handed are the sealed ones.

Task 5 exports the ballots. Without `voided` the seal cannot be recomputed from that file, so the offline recount proves the arithmetic but not the provenance. Adding the column closes it.

**Two things break if you only change the export.** `recount`'s parser refuses a row whose field count is neither expected value — a refusal added deliberately — so a three-column file would be rejected outright. And `recount` has no notion of a voided ballot, so it would **count** them. Both are fixed here, in the package that owns the format.

- [ ] **Step 1: Write the failing test**

```ts
describe('voided ballots in the CSV round trip', () => {
  const candidates = [{ id: 'a', name: 'Alex' }, { id: 'b', name: 'Bo' }]

  it('emits a voided column', () => {
    const csv = toBallotsCsv([
      { id: 'b1', preferences: ['a', 'b'], voided: false },
      { id: 'b2', preferences: ['b', 'a'], voided: true },
    ])
    expect(csv.split('\n')[0]).toBe('ballot_id,preferences,voided')
    expect(csv).toMatch(/"b2","b\|a","1"/)
  })

  it('EXCLUDES voided ballots from the count', async () => {
    const csv = toBallotsCsv([
      { id: 'b1', preferences: ['a'], voided: false },
      { id: 'b2', preferences: ['a'], voided: false },
      { id: 'b3', preferences: ['b'], voided: true },
    ])
    const r = await recount(csv, toCandidatesCsv(candidates), 1, 'e', 'ff'.repeat(8))
    expect(r.quota).toBe('2.00000')        // 2 counted, not 3
    expect(r.winners.map((w) => w.id)).toEqual(['a'])
  })

  it('still round-trips against a direct count', async () => {
    const ballots = [
      { id: 'b1', preferences: ['a', 'b'], voided: false },
      { id: 'b2', preferences: ['b', 'a'], voided: false },
      { id: 'b3', preferences: ['a', 'b'], voided: false },
    ]
    const viaCsv = await recount(toBallotsCsv(ballots), toCandidatesCsv(candidates), 1, 'e', 'ff'.repeat(8))
    const direct = await count({
      candidates, ballots: ballots.map(({ id, preferences }) => ({ id, preferences })),
      seats: 1, electionId: 'e', ballotsSha256: 'ff'.repeat(8),
    })
    expect(viaCsv).toEqual(direct)
  })

  it('rejects a voided value that is neither 0 nor 1', () => {
    const csv = 'ballot_id,preferences,voided\n"b1","a","maybe"\n'
    return expect(recount(csv, toCandidatesCsv(candidates), 1, 'e', 'ff'.repeat(8)))
      .rejects.toThrow(/voided|corrupt/i)
  })

  it('rejects the old two-column format rather than guessing', () => {
    const csv = 'ballot_id,preferences\n"b1","a"\n'
    return expect(recount(csv, toCandidatesCsv(candidates), 1, 'e', 'ff'.repeat(8)))
      .rejects.toThrow(/field|corrupt/i)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run -w @election/core test -- recount`
Expected: FAIL — `toBallotsCsv` emits two columns

- [ ] **Step 3: Write minimal implementation**

- `toBallotsCsv(ballots: { id: string; preferences: string[]; voided: boolean }[])` emits `ballot_id,preferences,voided` with `voided` as `0`/`1`.
  **`voided` is required, not optional with a `false` default**, even though that means updating
  existing test fixtures. This is the one path whose whole purpose is provenance: a caller who
  forgot the field would write `0` for a voided ballot and produce a digest that silently disagrees
  with the seal.
- `recount` expects exactly three fields per data row; anything else keeps the existing corrupt-file refusal. A `voided` value other than `0` or `1` is also corrupt.
- Rows with `voided = 1` are parsed, **counted in no tally**, and simply not passed to `count`.
- Keep the existing quote-aware parser, the unterminated-quote refusal, and the `|` guard on candidate ids.
- Update the header comment in `recount.ts` to say the file is now sufficient to recompute the seal.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run -w @election/core test && npm run -w @election/core typecheck`
Expected: PASS, all 135 plus the new ones

- [ ] **Step 5: Commit**

```bash
git add packages/core
git commit -m "feat(core): carry voided through the ballot CSV so the seal is reproducible"
```

---

### Task 5: Exports

**Files:**
- Create: `apps/api/src/routes/exports.ts`
- Modify: `apps/api/src/index.ts`, `docs/superpowers/specs/...` (§2's reproducibility caveat)
- Test: `apps/api/tests/exports.test.ts`

**Interfaces:**
- Consumes: `toBallotsCsv`, `toCandidatesCsv` from `@election/core`, `requireRole('officer')`
- Produces: `GET .../attendance.csv`, `GET /api/batches/:id/attendance.csv`, `GET .../ballots.csv`, `GET .../result.json`

**What each export is for.** The attendance CSV is the roll mark-off — who voted, never what. The ballot CSV is the anonymous box, and with Task 4's `voided` column a disputing party can now recompute `ballots_sha256` and confirm these are the sealed ballots before recounting them. The result JSON is the sealed count with every tie-break and its reasoning.

**`Content-Disposition` is already exposed** by Plan 2a's CORS config, so a frontend can fetch these to a blob and read the filename.

- [ ] **Step 1: Write the failing test**

```ts
describe('exports', () => {
  it('requires an officer session', async () => {
    expect((await getCsv('/attendance.csv', '')).status).toBe(401)
  })

  it('exports attendance as who voted, never what', async () => {
    await close()
    const text = await (await getCsv(`/elections/${eid}/attendance.csv`)).text()
    expect(text.split('\n')[0]).toBe('usu_id,first_name,last_name,voted_at,recast_count')
    expect(text).not.toMatch(/preferences|ballot_id/)
  })

  it('sets a Content-Disposition filename', async () => {
    await close()
    const res = await getCsv(`/elections/${eid}/attendance.csv`)
    expect(res.headers.get('content-disposition')).toMatch(/attachment; filename=/)
    expect(res.headers.get('content-type')).toMatch(/text\/csv/)
  })

  it('exports ballots anonymously, with no voter reference', async () => {
    await close()
    const text = await (await getCsv(`/elections/${eid}/ballots.csv`)).text()
    expect(text.split('\n')[0]).toBe('ballot_id,preferences,voided')
    expect(text).not.toMatch(/\d{7}/)      // no usu_id anywhere
  })

  it('exports ballots ORDERED BY ID, so the digest can be recomputed', async () => {
    await close()
    const text = await (await getCsv(`/elections/${eid}/ballots.csv`)).text()
    const ids = text.trim().split('\n').slice(1).map((l) => l.split(',')[0]!.replace(/"/g, ''))
    expect(ids).toEqual([...ids].sort())
  })

  it('LETS A THIRD PARTY RECOMPUTE THE SEAL from the export alone', async () => {
    await close()
    const text = await (await getCsv(`/elections/${eid}/ballots.csv`)).text()
    const rows = text.trim().split('\n').slice(1).map((l) => {
      const [id, prefs, voided] = l.split('","').map((f) => f.replace(/^"|"$/g, ''))
      return { id: id!, preferences: JSON.stringify(prefs!.split('|').filter(Boolean)), voided: Number(voided!) }
    })
    const canonical = rows.map((r) => `${r.id}|${r.preferences}|${r.voided}`).join('\n')
    const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical)))]
      .map((b) => b.toString(16).padStart(2, '0')).join('')
    const seal = await env.DB.prepare('SELECT ballots_sha256 FROM election_seal').first<{ ballots_sha256: string }>()
    expect(digest).toBe(seal!.ballots_sha256)
  })

  it('refuses a ballot export before the election is closed', async () => {
    expect((await getCsv(`/elections/${eid}/ballots.csv`)).status).toBe(409)
  })

  it('exports the whole batch attendance across elections', async () => {
    await close()
    const text = await (await getCsv('/attendance.csv')).text()
    expect(text.split('\n')[0]).toBe('election_id,election_name,usu_id,first_name,last_name,voted_at')
  })

  it('exports the sealed result with its tie-breaks', async () => {
    await closeAndCount()
    const body = await (await getCsv(`/elections/${eid}/result.json`)).json() as Record<string, unknown>
    expect(Object.keys(body).sort()).toEqual(['ballot_count', 'ballots_sha256', 'closed_at', 'computed_at', 'election', 'overridden', 'rounds', 'tie_breaks', 'winners'])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run -w @election/api test -- exports`
Expected: FAIL — routes not registered

- [ ] **Step 3: Write minimal implementation**

All behind `requireRole('officer')`. Ballot and result exports 409 unless closed and sealed; attendance is available whenever the election exists.

- `attendance.csv` — **LEFT** JOIN from `vote_receipt` to `voter_roll`, `ORDER BY last_name, first_name`. Left, because Task 7's purge deletes the roll and an inner join would then return a header and no rows; who voted is still a fact after the names are gone.
- `ballots.csv` — `SELECT id, preferences, voided FROM ballot WHERE election_id = ? ORDER BY id` (**explicit**), fed through `toBallotsCsv`.
- `result.json` — the current non-superseded `election_result` plus the seal fields.
- Every response sets `Content-Type` and `Content-Disposition: attachment; filename=...`.
- Amend spec §2: the export now carries `voided`, so the seal **is** reproducible from it. Replace the caveat with a statement of what the export proves.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run -w @election/api test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/api docs/superpowers/specs
git commit -m "feat(api): exports, and the seal is now reproducible from the ballot CSV"
```

---

### Task 6: R2 logo upload

**Files:**
- Create: `apps/api/src/routes/logo.ts`, `apps/api/src/lib/imageType.ts`
- Modify: `apps/api/wrangler.jsonc`, `apps/api/src/index.ts`, `apps/api/vitest.config.ts`
- Test: `apps/api/tests/logo.test.ts`

**Interfaces:**
- Consumes: `requireRole('officer')`
- Produces: `detectImageType(bytes): 'png' | 'jpeg' | 'gif' | 'webp' | null`; `POST /api/batches/:id/logo`, `GET /api/logos/:key`

**Three legacy holes close here.** Spec §6: the old `POST /batches/<id>/logo` had **no auth decorator at all**, so anyone could overwrite any society's logo; it validated by file extension, so the check was trivially bypassed; and it wrote to Render's ephemeral disk, so logos vanished on restart. R2, officer auth, and magic-byte detection.

**Keys are content hashes.** `batches/<batchId>/<sha256>.<ext>`. Two societies uploading `logo.png` no longer collide — the legacy `secure_filename` collapsed them onto one path.

- [ ] **Step 1: Write the failing test**

```ts
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, /* ... */])
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, /* ... */])

describe('logo upload', () => {
  it('REQUIRES AN OFFICER SESSION — the legacy route had none', async () => {
    expect((await upload(PNG, 'logo.png', '')).status).toBe(401)
    expect((await upload(PNG, 'logo.png', doorCookie)).status).toBe(403)
  })

  it('accepts a real PNG', async () => {
    const res = await upload(PNG, 'logo.png')
    expect(res.status).toBe(201)
    expect((await res.json() as { logo_url: string }).logo_url).toMatch(/^\/api\/logos\/batches\//)
  })

  it('REJECTS A FILE WHOSE BYTES ARE NOT AN IMAGE, whatever it is named', async () => {
    const html = new TextEncoder().encode('<script>alert(1)</script>')
    expect((await upload(html, 'logo.png')).status).toBe(400)
  })

  it('rejects a file that is too large', async () => {
    expect((await upload(new Uint8Array(3 * 1024 * 1024), 'big.png')).status).toBe(413)
  })

  it('keys by content hash, so two societies do not collide', async () => {
    const a = await (await upload(PNG, 'logo.png')).json() as { logo_url: string }
    const b = await (await upload(JPEG, 'logo.png')).json() as { logo_url: string }
    expect(a.logo_url).not.toBe(b.logo_url)
  })

  it('serves the object back with its real content type', async () => {
    const { logo_url } = await (await upload(PNG, 'logo.png')).json() as { logo_url: string }
    const res = await SELF.fetch(`https://example.com${logo_url}`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('image/png')
    expect(res.headers.get('cache-control')).toMatch(/max-age=/)
  })

  it('updates the batch branding to point at it', async () => {
    const { logo_url } = await (await upload(PNG, 'logo.png')).json() as { logo_url: string }
    const res = await SELF.fetch(`https://example.com/api/batches/by-slug/s`)
    const b = await res.json() as { branding: { logo_url: string } }
    expect(b.branding.logo_url).toBe(logo_url)
  })

  it('404s an unknown key', async () => {
    expect((await SELF.fetch('https://example.com/api/logos/batches/x/nope.png')).status).toBe(404)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run -w @election/api test -- logo`
Expected: FAIL — `env.LOGOS` undefined

- [ ] **Step 3: Write minimal implementation**

`apps/api/src/lib/imageType.ts` — sniff magic bytes, not the filename:

```ts
/**
 * The legacy implementation checked the file extension, which anyone can
 * choose. This reads the bytes.
 */
export type ImageType = { ext: 'png' | 'jpeg' | 'gif' | 'webp'; mime: string }

export function detectImageType(bytes: Uint8Array): ImageType | null {
  const b = (...xs: number[]) => xs.every((x, i) => bytes[i] === x)
  if (b(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return { ext: 'png', mime: 'image/png' }
  if (b(0xff, 0xd8, 0xff)) return { ext: 'jpeg', mime: 'image/jpeg' }
  if (b(0x47, 0x49, 0x46, 0x38)) return { ext: 'gif', mime: 'image/gif' }
  if (b(0x52, 0x49, 0x46, 0x46) && [0x57, 0x45, 0x42, 0x50].every((x, i) => bytes[8 + i] === x)) {
    return { ext: 'webp', mime: 'image/webp' }
  }
  return null
}
```

Upload: officer only; reject over 2 MB with 413; `detectImageType` null → 400; key `batches/<batchId>/<sha256>.<ext>`; `R2.put` with the sniffed `httpMetadata.contentType`; update `batch.branding.logo_url` and write the audit row in one `DB.batch()`.

Serve: `GET /api/logos/:key{.+}` — `R2.get`, 404 if absent, set `Content-Type` from stored metadata (**never from the request**) and a long `Cache-Control` since the key is a content hash.

Add `LOGOS: R2Bucket` to `Env`, an `r2_buckets` entry to `wrangler.jsonc`, and `r2Buckets: ['LOGOS']` to the vitest miniflare options.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run -w @election/api test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/api
git commit -m "feat(api): R2 logo upload, authenticated and validated by magic bytes"
```

---

### Task 7: Post-AGM roll purge

**Files:**
- Create: `apps/api/src/routes/purge.ts`
- Modify: `apps/api/src/index.ts`, `apps/api/src/db/audit.ts`
- Test: `apps/api/tests/purge.test.ts`

**Interfaces:**
- Consumes: `requireRole('officer')`
- Produces: `DELETE /api/batches/:id/roll`

**What this is for.** Spec §2: after the AGM, `voter_roll` and `check_in` are purged. **That is all the personal data.** `ballot`, `election_seal` and `election_result` are anonymous and are the audit record, so they stay. You end up holding a fully defensible count and none of the 1,302 members' details.

**Refuse while any election is still open or draft.** Purging the roll mid-AGM would make every remaining voter ineligible — 2b's ballot insert re-checks `voter_roll` on every submission, by design. This must be a deliberate end-of-event action.

**The seal is what makes this safe.** Deleting the roll does not weaken the result, because the count was sealed against the ballots, not the roll.

- [ ] **Step 1: Write the failing test**

```ts
describe('roll purge', () => {
  it('requires an officer session', async () => {
    expect((await purge('')).status).toBe(401)
  })

  it('REFUSES while an election is still open', async () => {
    expect((await purge()).status).toBe(409)
    const row = await env.DB.prepare('SELECT count(*) c FROM voter_roll').first<{ c: number }>()
    expect(row!.c).toBeGreaterThan(0)
  })

  it('refuses while an election is still in draft', async () => {
    await close()
    await createElection({ name: 'Later', seats: 1 })
    expect((await purge()).status).toBe(409)
  })

  it('purges the roll and check-ins once every election is closed', async () => {
    await close()
    const res = await purge()
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ voter_roll: 6, check_in: 1 })
    for (const t of ['voter_roll', 'check_in']) {
      const row = await env.DB.prepare(`SELECT count(*) c FROM ${t}`).first<{ c: number }>()
      expect(row!.c).toBe(0)
    }
  })

  it('KEEPS the ballots, the seal and the result', async () => {
    await closeAndCount()
    await purge()
    for (const t of ['ballot', 'election_seal', 'election_result']) {
      const row = await env.DB.prepare(`SELECT count(*) c FROM ${t}`).first<{ c: number }>()
      expect(row!.c).toBeGreaterThan(0)
    }
  })

  it('keeps vote_receipt, because it is the mark-off on the roll', async () => {
    await closeAndCount()
    await purge()
    const row = await env.DB.prepare('SELECT count(*) c FROM vote_receipt').first<{ c: number }>()
    expect(row!.c).toBeGreaterThan(0)
  })

  it('leaves the result still readable and unchanged', async () => {
    const before = await (await getResult()).text()
    await purge()
    expect(await (await getResult()).text()).toBe(before)
  })

  it('is idempotent', async () => {
    await close()
    await purge()
    expect((await purge()).status).toBe(200)
  })

  it('records an audit row with row counts and no identities', async () => {
    await close()
    await purge()
    const row = await env.DB.prepare(`SELECT detail FROM audit_log WHERE action = 'roll.purge'`).first<{ detail: string }>()
    expect(JSON.parse(row!.detail)).toMatchObject({ kind: 'roll_purge' })
    expect(row!.detail).not.toMatch(/\d{7}/)
  })
})
```

**A decision to make deliberately in Step 3, not by accident:** `vote_receipt.usu_id` is an identifier and it survives this purge. That is intentional — it is the mark-off proving who voted, which is half the integrity story and the thing an attendance export is built from. If you disagree, say so rather than quietly deleting it; the tests above pin the current intent.

**DECIDED (2026-09-21): keep it, and fix the spec instead.** Spec §2's retention paragraph says
`voter_roll` and `check_in` are purged and that "that is all the personal data", which is not true
while `vote_receipt.usu_id` exists. Deleting the mark-off would destroy integrity evidence to make a
sentence true; leaving the sentence would be a false claim about data handling. So this task also
amends spec §2 to name `vote_receipt`, state that it is retained, and say why.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run -w @election/api test -- purge`
Expected: FAIL — route not registered

- [ ] **Step 3: Write minimal implementation**

1. `requireRole('officer')`.
2. `SELECT count(*) FROM election WHERE batch_id = ? AND status != 'closed'` — non-zero → 409 naming how many remain.
3. Count rows, then `DB.batch([deleteCheckIn, deleteRoll, auditStatement])` — `check_in` first, since it has a foreign key onto `voter_roll`.
4. Return the counts. Idempotent: a second call deletes nothing and returns zeros.
5. Add the `roll_purge` variant to `AuditDetail` if absent.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run -w @election/api test && npm run -w @election/api typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/api
git commit -m "feat(api): post-AGM roll purge, keeping the anonymous audit record"
```

---

### Task 8: The two spec §5 routes both plans missed

Found by the plan-vs-spec check, not by the plans: `PATCH /api/batches/:id/branding` and
`GET /api/batches/:id/elections/:eid/turnout` appear in spec §5 and in no task of 2a, 2b or 2c. This
plan's closing line claims `apps/api` is complete against spec §5, so either they are built or that
claim is withdrawn.

**Turnout is not cosmetic.** Spec §4's officer row for `open` reads "see turnout only". Withholding
the tally until close is the central control, and turnout is the thing that makes it bearable — an
officer with no visibility at all during voting has no way to know whether to keep the doors open.
It must therefore be **exactly** turnout and nothing else: ballots cast and eligible voters, never a
per-candidate figure, at any status.

**Files:**
- Create: `apps/api/src/routes/turnout.ts`, `apps/api/src/routes/branding.ts`
- Modify: `apps/api/src/index.ts`
- Test: `apps/api/tests/turnout.test.ts`, `apps/api/tests/branding.test.ts`

**Implementation:**
- `GET .../turnout` behind `requireRole('officer')` → `{ ballots_cast, voters_checked_in, eligible }`.
  `ballots_cast` counts **non-voided** ballots. **No candidate breakdown, and no tally, ever** — a
  turnout endpoint that leaks a per-candidate count reopens exactly what spec §4 closes.
- `PATCH .../branding` behind `requireRole('officer')`, reusing `brandingSchema` from
  `routes/batches.ts` rather than restating it — one schema, so the provisioning path and the edit
  path cannot drift on what a valid accent colour or logo URL is. Audit `branding.update` with no
  detail.

**Tests must include:** turnout refused without an officer session; turnout available while open;
turnout containing no candidate id or candidate name at any status; branding rejecting a bad accent
colour and a `javascript:` logo URL through the shared schema; and branding surviving a round trip
through the public `by-slug` route.

- [ ] Step 1: failing tests · Step 2: watch them fail · Step 3: implement · Step 4: full suite · Step 5: commit

```bash
git commit -m "feat(api): officer turnout and branding edit, the two spec §5 routes the plans missed"
```

---

## Success criteria for Plan 2c

- `npm run -w @election/api test` and `npm run -w @election/core test` both pass; both typecheck clean.
- `apps/api` still depends only on `hono`, `zod`, `@election/core`; `packages/core` still has zero runtime dependencies.
- A closed election cannot be reopened, and a second close is refused.
- No result is obtainable before an election is closed.
- Voided ballots are in the seal and out of the count.
- **A third party can recompute `ballots_sha256` from the exported ballot CSV alone** and get the sealed value.
- An override writes a new result row and never deletes the superseded one; the officer's reason appears in the result document.
- A logo whose bytes are not an image is rejected however it is named, and the upload route cannot be reached without an officer session.
- After the purge, `voter_roll` and `check_in` are empty while `ballot`, `election_seal`, `election_result` and `vote_receipt` are intact and the result is unchanged.
- **`vote_receipt.live_receipt_hash` is NULL for every row of a closed election**, so the ballot↔voter join Plan 2b introduced does not outlive the count.
- Turnout is obtainable while an election is open and contains no candidate id, candidate name or tally at any status.

## What remains after Plan 2c

`apps/api` is then complete against spec §5. Plan 3 builds the two frontends: the voter app (Preact, ranked-ballot UI rebuilt as an explicit ranked list rather than click-order checkboxes) and the admin app (React 19), both against the shared-apex requirement in spec §1 — auth cannot be tested on preview URLs.
