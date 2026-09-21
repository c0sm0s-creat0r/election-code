# apps/api Guests and Door Additions Implementation Plan (Plan 2d)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the door desk record two kinds of person the membership export does not contain — a guest who attends but cannot vote, and a member the export missed who can — without making either one invisible in the record afterwards.

**Architecture:** One migration adding a `guest` table and a `voter_roll.added_at_door` flag, five new endpoints on the existing door and officer routers, and three existing surfaces extended so a door-added voter is never counted without its provenance: `GET /quorum`, both attendance exports, and the post-AGM purge.

**Tech Stack:** Hono, Zod, Cloudflare D1, Vitest with `@cloudflare/vitest-pool-workers`.

**Spec:** `docs/superpowers/specs/2026-09-21-frontends-design.md` §0 (this plan implements that section in full). Parent spec: `docs/superpowers/specs/2026-09-16-election-code-rewrite-design.md` §2 (retention), §4 (door flow), §6 (security posture).
**Handoff — READ §2 BEFORE TASK 1:** `docs/superpowers/HANDOFF.md`

**Plan 2d of the API sequence.** 2a (foundation), 2b (voting path) and 2c (result path) are complete at 359 tests. This plan must land **before Plan 3b**, because the door UI consumes it.

## Global Constraints

- **`apps/api` runtime dependencies stay exactly `hono`, `zod`, `@election/core`.** No additions.
- **No ORM.** D1 prepared statements only. `0001`, `0002` and `0003` are applied and **immutable**; this plan's schema change goes in `0004`.
- TypeScript `strict`, `noUncheckedIndexedAccess`, `noUnusedLocals`. No `any` in exported signatures.
- Every request body validated with Zod at the boundary. Ids from `crypto.randomUUID()`.
- **Every gated route is `/api/batches/:id/...`** — `requireRole` binds the literal param name `id`. A route written `:batchId` yields a middleware that denies everything.
- **`AuditEntry.detail` is an allow-list.** The four actions this plan adds carry **no detail at all**: a guest's name and a door-added member's `usu_id` are exactly what must never reach a table the purge cannot touch. Accountability lives in `voter_roll.added_at_door` and the attendance exports, which the purge *can* reach.
- **A guest must never be able to vote.** The `guest` table has no `usu_id`, so the ballot insert's eligibility clause has nothing to match. Do not add one, and do not "fix" a guest into `voter_roll`.
- **Never present a door-added total without its provenance.** Every surface that reports voter counts reports `added_at_door` beside them.
- TDD throughout: failing test, watch it fail, implement, commit.

---

### Task 1: Migration 0004 and row types

**Files:**
- Create: `apps/api/migrations/0004_guests_and_door_additions.sql`
- Modify: `apps/api/src/db/types.ts`, `apps/api/tests/helpers.ts`
- Test: `apps/api/tests/schema.test.ts`

**Add `'guest'` to `ALL_TABLES` in `apps/api/tests/helpers.ts` as part of this task.** `resetDatabase`
truncates that list between tests; a new table missing from it leaks rows into every later test in the
file, which surfaces later as an unrelated count being wrong by one.

**Interfaces:**
- Produces: the `guest` table; `voter_roll.added_at_door`; `GuestRow`; `VoterRollRow.added_at_door`

**Why a table for guests and a flag for members.** A guest is not a member, so putting them in
`voter_roll` would corrupt what the roll means, what the import's upsert does on the next re-import,
and what "1,298 eligible" counts. A door-added member is the opposite case — they genuinely belong on
the roll — so they are a roll row carrying a flag.

- [ ] **Step 1: Write the failing test**

Append to `apps/api/tests/schema.test.ts`:

```ts
describe('0004: guests and door additions', () => {
  it('creates a guest table with no usu_id — a guest cannot be joined to the roll', async () => {
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS)
    const cols = await env.DB.prepare('PRAGMA table_info(guest)').all<{ name: string }>()
    expect(cols.results.map((r) => r.name).sort()).toEqual(['batch_id', 'checked_in_at', 'id', 'name', 'note'])
  })

  it('adds added_at_door to voter_roll, defaulting to 0', async () => {
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS)
    const cols = await env.DB.prepare('PRAGMA table_info(voter_roll)').all<{ name: string; dflt_value: string | null }>()
    const col = cols.results.find((c) => c.name === 'added_at_door')
    expect(col).toBeTruthy()
    expect(col!.dflt_value).toBe('0')
  })

  it('leaves the imported roll flagged as not door-added', async () => {
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS)
    await env.DB.prepare(`INSERT INTO batch (id, slug, name, officer_hash, door_hash, branding, created_at)
                          VALUES ('b','s','n','h','h','{}',1)`).run()
    await env.DB.prepare(`INSERT INTO voter_roll (batch_id, usu_id, first_name, last_name, eligible)
                          VALUES ('b','2400001','Ada','Lovelace',1)`).run()
    const row = await env.DB.prepare('SELECT added_at_door FROM voter_roll').first<{ added_at_door: number }>()
    expect(row!.added_at_door).toBe(0)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run -w @election/api test -- schema`
Expected: FAIL — `no such table: guest`

- [ ] **Step 3: Write minimal implementation**

`apps/api/migrations/0004_guests_and_door_additions.sql`:

```sql
-- Two kinds of person the USU export does not contain.
--
-- A GUEST attends and cannot vote: an observer, a partner organisation, staff.
-- They get their own table rather than a row in voter_roll, because they are
-- not members -- putting them on the roll would change what the roll means,
-- what the import's upsert does on re-import, and what "1,298 eligible" counts.
--
-- There is deliberately NO usu_id column here, and that absence is the control.
-- Ballot submission's eligibility clause joins voter_roll to check_in by
-- (batch_id, usu_id); a guest has nothing for it to match, so a guest cannot
-- vote because the query finds nothing, not because a check says no. Do not add
-- a usu_id to this table.
CREATE TABLE guest (
  id            TEXT PRIMARY KEY,     -- crypto.randomUUID()
  batch_id      TEXT NOT NULL REFERENCES batch(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,        -- as the volunteer typed it
  note          TEXT,                 -- optional: "observer, USU exec"
  checked_in_at INTEGER NOT NULL
);

CREATE INDEX guest_batch ON guest(batch_id);

-- A MEMBER the export missed is the opposite case: they genuinely belong on the
-- roll, so they are a roll row with a flag.
--
-- This flag is the reason that feature is defensible. A door password can now
-- enrol a voter, so "eligibility derives from the membership export" becomes
-- "derives from the export, plus N people the door staff added" -- and N must
-- never be hidden. It is reported by GET /quorum and carried as a column in both
-- attendance exports.
--
-- NEVER CLEARED. If a corrected export later contains that member, the import's
-- upsert refreshes their name and eligibility and leaves this alone: a human
-- created the row at a desk, and a later file cannot un-happen it. The upsert's
-- SET list must not mention this column.
ALTER TABLE voter_roll ADD COLUMN added_at_door INTEGER NOT NULL DEFAULT 0;
```

In `apps/api/src/db/types.ts`, add `added_at_door: number // 0 | 1; see migration 0004` to
`VoterRollRow`, and add:

```ts
/** Someone in the room who is not on the roll and cannot vote. Migration 0004. */
export type GuestRow = {
  id: string
  batch_id: string
  name: string
  note: string | null
  checked_in_at: number
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run -w @election/api test && npm run -w @election/api typecheck`
Expected: PASS, all existing 359 plus the new ones

- [ ] **Step 5: Commit**

```bash
git add apps/api
git commit -m "feat(api): schema for guests and door-added members"
```

---

### Task 2: Guests — add, list, remove

**Files:**
- Create: `apps/api/src/routes/guests.ts`
- Modify: `apps/api/src/index.ts`, `apps/api/src/routes/checkIn.ts` (quorum), `apps/api/tests/checkIn.test.ts`
- Test: `apps/api/tests/guests.test.ts`

**Interfaces:**
- Consumes: `requireRole('door')`, `requireSession`, `auditLogStatement`, `pathParam`, `rateLimit`, `RATE_LIMITS`
- Produces: `POST /api/batches/:id/guests`, `GET /api/batches/:id/guests`, `DELETE /api/batches/:id/guests/:guestId`; `GET /api/batches/:id/quorum` gains `guests`

**Quorum must not move.** Spec §4 defines quorum as `checked_in / eligible` against the roll. A guest
is not an eligible member, so `guests` is a third number reported beside the ratio and never summed
into it.

**This changes an existing assertion.** `apps/api/tests/checkIn.test.ts` asserts the quorum body with
`toEqual({ checked_in: 2, eligible: 4 })`, which a third key fails. That is the assertion doing its
job — it pins the response shape — so update it to
`toEqual({ checked_in: 2, eligible: 4, guests: 0 })`.

**Do not add `added_at_door` to that assertion in this task.** Task 3 introduces the fourth key and
updates the same line again. Asserting it here would leave Task 2's own suite failing, which breaks the
rule that every task ends green.

- [ ] **Step 1: Write the failing test**

`apps/api/tests/guests.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest'
import { SELF, env } from 'cloudflare:test'
import { setUp, JSON_HEADERS, type Fixture } from './helpers.js'

let f: Fixture

beforeEach(async () => { f = await setUp(['2400001']) })

const addGuest = (body: unknown, cookie = f.doorCookie) =>
  SELF.fetch(`https://example.com/api/batches/${f.batchId}/guests`, {
    method: 'POST', headers: { ...JSON_HEADERS, cookie }, body: JSON.stringify(body),
  })

const listGuests = (cookie = f.doorCookie) =>
  SELF.fetch(`https://example.com/api/batches/${f.batchId}/guests`, { headers: { cookie } })

const removeGuest = (id: string, cookie = f.doorCookie) =>
  SELF.fetch(`https://example.com/api/batches/${f.batchId}/guests/${id}`, {
    method: 'DELETE', headers: { cookie },
  })

const quorum = () =>
  SELF.fetch(`https://example.com/api/batches/${f.batchId}/quorum`, { headers: { cookie: f.doorCookie } })

describe('guests', () => {
  it('requires a door session', async () => {
    expect((await addGuest({ name: 'Visitor' }, '')).status).toBe(401)
  })

  it('refuses an officer session', async () => {
    expect((await addGuest({ name: 'Visitor' }, f.officerCookie)).status).toBe(403)
  })

  it('adds a guest', async () => {
    const res = await addGuest({ name: 'Jo Visitor', note: 'observer' })
    expect(res.status).toBe(201)
    expect(await res.json()).toMatchObject({ name: 'Jo Visitor' })
  })

  it('accepts a guest with no note', async () => {
    expect((await addGuest({ name: 'Jo Visitor' })).status).toBe(201)
  })

  it('rejects an empty name', async () => {
    expect((await addGuest({ name: '   ' })).status).toBe(400)
  })

  it('lists guests for the door', async () => {
    await addGuest({ name: 'Jo Visitor', note: 'observer' })
    const rows = await (await listGuests()).json() as Array<Record<string, unknown>>
    expect(rows).toHaveLength(1)
    expect(Object.keys(rows[0]!).sort()).toEqual(['checked_in_at', 'id', 'name', 'note'])
  })

  it('removes a guest, because a mistaken tap needs undoing', async () => {
    const { id } = await (await addGuest({ name: 'Typo' })).json() as { id: string }
    expect((await removeGuest(id)).status).toBe(204)
    expect(await (await listGuests()).json()).toEqual([])
  })

  it('removing an unknown guest is not an error', async () => {
    expect((await removeGuest(crypto.randomUUID())).status).toBe(204)
  })

  it('cannot remove another batch\'s guest', async () => {
    const { id } = await (await addGuest({ name: 'Ours' })).json() as { id: string }
    const other = await (await SELF.fetch('https://example.com/api/batches', {
      method: 'POST',
      headers: { ...JSON_HEADERS, 'x-super-admin-key': 'super-secret-test-key' },
      body: JSON.stringify({
        name: 'Other', slug: 'other', officer_password: 'officer-password-2', door_password: 'door-password-2',
        branding: { title: 't', org_name: 'o', accent_color: '#000000', logo_url: '' },
      }),
    })).json() as { id: string }
    const otherDoor = ((await (await SELF.fetch(`https://example.com/api/batches/${other.id}/door/session`, {
      method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ password: 'door-password-2' }),
    })).headers.get('set-cookie')) ?? '').split(';')[0]!
    await SELF.fetch(`https://example.com/api/batches/${other.id}/guests/${id}`, {
      method: 'DELETE', headers: { cookie: otherDoor },
    })
    const row = await env.DB.prepare('SELECT count(*) c FROM guest').first<{ c: number }>()
    expect(row!.c).toBe(1)
  })

  it('A GUEST IS NOT ON THE ROLL, so they cannot be checked in as a voter', async () => {
    const rollBefore = await env.DB.prepare('SELECT count(*) c FROM voter_roll').first<{ c: number }>()
    await addGuest({ name: 'Jo Visitor' })
    // adding a guest creates no roll row at all, which is the control
    const rollAfter = await env.DB.prepare('SELECT count(*) c FROM voter_roll').first<{ c: number }>()
    expect(rollAfter!.c).toBe(rollBefore!.c)
    // and nothing that is not on the roll can be checked in. (A guest id is a
    // 36-char UUID, which checkInSchema's max(32) rejects as a 400 before the
    // lookup, so this uses a well-formed id that is simply absent.)
    const res = await SELF.fetch(`https://example.com/api/batches/${f.batchId}/check-in`, {
      method: 'POST', headers: { ...JSON_HEADERS, cookie: f.doorCookie },
      body: JSON.stringify({ usu_id: '9999999' }),
    })
    expect(res.status).toBe(404)
  })

  it('A GUEST CANNOT SIGN IN TO VOTE', async () => {
    await addGuest({ name: 'Jo Visitor' })
    const res = await SELF.fetch(`https://example.com/api/batches/${f.batchId}/voter/session`, {
      method: 'POST', headers: JSON_HEADERS,
      body: JSON.stringify({ usu_id: '9999999', surname: 'Visitor' }),
    })
    expect(res.status).toBe(401)
  })

  it('reports guests in quorum WITHOUT moving checked_in or eligible', async () => {
    const before = await (await quorum()).json()
    await addGuest({ name: 'Jo Visitor' })
    const after = await (await quorum()).json() as Record<string, number>
    expect(after.guests).toBe(1)
    expect({ ...after, guests: 0 }).toEqual(before)
  })

  it('records add and remove in the audit log with NO name', async () => {
    const { id } = await (await addGuest({ name: 'Jo Verydistinctive' })).json() as { id: string }
    await removeGuest(id)
    const rows = await env.DB.prepare(`SELECT action, detail FROM audit_log WHERE action LIKE 'guest%'`)
      .all<{ action: string; detail: string | null }>()
    expect(rows.results.map((r) => r.action).sort()).toEqual(['guest.add', 'guest.remove'])
    for (const r of rows.results) expect(r.detail).toBeNull()
    const all = await env.DB.prepare('SELECT * FROM audit_log').all()
    expect(JSON.stringify(all.results)).not.toMatch(/Verydistinctive/)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run -w @election/api test -- guests`
Expected: FAIL — routes not registered

- [ ] **Step 3: Write minimal implementation**

`apps/api/src/routes/guests.ts`, all three routes behind `requireRole('door')` with
`rateLimit(RATE_LIMITS.voting)` on the create route:

- Zod: `{ name: z.string().trim().min(1).max(200), note: z.string().trim().max(500).optional() }`.
- `POST` — `INSERT INTO guest (id, batch_id, name, note, checked_in_at) VALUES (?,?,?,?,?)` batched
  with `auditLogStatement({ action: 'guest.add' })` — **no detail**. Return `201 { id, name }`.
- `GET` — `SELECT id, name, note, checked_in_at FROM guest WHERE batch_id = ? ORDER BY checked_in_at`.
- `DELETE` — `DELETE FROM guest WHERE id = ? AND batch_id = ?`, 204 whether or not a row matched
  (idempotent, same reasoning as un-check-in). Audit `guest.remove` only when `changes > 0`.

In `checkIn.ts`, add a third subquery to the quorum statement:
`(SELECT count(*) FROM guest WHERE batch_id = ?1) AS guests`, and include `guests` in the response.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run -w @election/api test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/api
git commit -m "feat(api): guest attendance, counted beside quorum and never in it"
```

---

### Task 3: A member the export missed

**Files:**
- Create: `apps/api/src/routes/doorVoters.ts`
- Modify: `apps/api/src/index.ts`, `apps/api/src/routes/checkIn.ts` (quorum)
- Test: `apps/api/tests/doorVoters.test.ts`

**Interfaces:**
- Consumes: `requireRole('door')`, `requireSession`, `auditLogStatement`, `pathParam`, `rateLimit`
- Produces: `POST /api/batches/:id/voters`, `DELETE /api/batches/:id/voters/:usuId`; `GET /api/batches/:id/quorum` gains `added_at_door`

**The three rules that make this safe, and the reason for each:**

1. **Create the roll row and the check-in in ONE transaction.** The volunteer's intent is "this person
   is here and needs to vote"; a roll row without a check-in is a member who still cannot vote.
2. **Refuse a `usu_id` already on the roll, with 409 — this is not an upsert.** A mistyped id that
   happens to match a real member would otherwise overwrite that member's name with the typed one. The
   409 tells the volunteer the right action: search for them and check them in.
3. **`DELETE` refuses unless `added_at_door = 1` and that member has cast no ballot in this batch.**
   Deleting a roll row for someone who has voted destroys the eligibility evidence behind a ballot
   that is already in the box, and no door volunteer should be able to do that by tapping undo.

- [ ] **Step 1: Write the failing test**

`apps/api/tests/doorVoters.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest'
import { SELF, env } from 'cloudflare:test'
import { setUp, submitBallot, voterSignIn, JSON_HEADERS, type Fixture } from './helpers.js'

let f: Fixture

beforeEach(async () => { f = await setUp(['2400001']) })

const NEW_MEMBER = { usu_id: '2400777', first_name: 'Nina', last_name: 'Newjoiner' }

const addVoter = (body: unknown, cookie = f.doorCookie) =>
  SELF.fetch(`https://example.com/api/batches/${f.batchId}/voters`, {
    method: 'POST', headers: { ...JSON_HEADERS, cookie }, body: JSON.stringify(body),
  })

const removeVoter = (usuId: string, cookie = f.doorCookie) =>
  SELF.fetch(`https://example.com/api/batches/${f.batchId}/voters/${usuId}`, {
    method: 'DELETE', headers: { cookie },
  })

const quorum = async () =>
  await (await SELF.fetch(`https://example.com/api/batches/${f.batchId}/quorum`, {
    headers: { cookie: f.doorCookie },
  })).json() as Record<string, number>

describe('adding a member the export missed', () => {
  it('requires a door session', async () => {
    expect((await addVoter(NEW_MEMBER, '')).status).toBe(401)
  })

  it('refuses an officer session', async () => {
    expect((await addVoter(NEW_MEMBER, f.officerCookie)).status).toBe(403)
  })

  it('adds the member and checks them in, in one step', async () => {
    const res = await addVoter(NEW_MEMBER)
    expect(res.status).toBe(201)
    const roll = await env.DB.prepare('SELECT eligible, added_at_door FROM voter_roll WHERE usu_id = ?')
      .bind(NEW_MEMBER.usu_id).first<{ eligible: number; added_at_door: number }>()
    expect(roll).toMatchObject({ eligible: 1, added_at_door: 1 })
    const checkIn = await env.DB.prepare('SELECT count(*) c FROM check_in WHERE usu_id = ?')
      .bind(NEW_MEMBER.usu_id).first<{ c: number }>()
    expect(checkIn!.c).toBe(1)
  })

  it('LETS THEM SIGN IN AND VOTE — the point of the feature', async () => {
    await addVoter(NEW_MEMBER)
    const cookie = await voterSignIn(f.batchId, NEW_MEMBER.usu_id, NEW_MEMBER.last_name)
    expect(cookie).toMatch(/es_voter_/)
    const res = await submitBallot(f.batchId, f.electionId, cookie, [f.candidateIds.a])
    expect(res.status).toBe(201)
  })

  it('REFUSES a usu_id already on the roll, and leaves that member untouched', async () => {
    const res = await addVoter({ usu_id: '2400001', first_name: 'Wrong', last_name: 'Name' })
    expect(res.status).toBe(409)
    const row = await env.DB.prepare('SELECT first_name, added_at_door FROM voter_roll WHERE usu_id = ?')
      .bind('2400001').first<{ first_name: string; added_at_door: number }>()
    expect(row).toMatchObject({ first_name: 'Ada', added_at_door: 0 })
  })

  it('rejects a malformed usu_id', async () => {
    for (const usu_id of ['', 'abc', '123', '2400001x']) {
      expect((await addVoter({ ...NEW_MEMBER, usu_id })).status, usu_id).toBe(400)
    }
  })

  it('rejects an empty name', async () => {
    expect((await addVoter({ ...NEW_MEMBER, last_name: '  ' })).status).toBe(400)
  })

  it('counts them in eligible and checked_in, and reports added_at_door beside both', async () => {
    const before = await quorum()
    await addVoter(NEW_MEMBER)
    const after = await quorum()
    expect(after.eligible).toBe(before.eligible! + 1)
    expect(after.checked_in).toBe(before.checked_in! + 1)
    expect(after.added_at_door).toBe(1)
  })

  it('removes a mistyped entry', async () => {
    await addVoter(NEW_MEMBER)
    expect((await removeVoter(NEW_MEMBER.usu_id)).status).toBe(204)
    const row = await env.DB.prepare('SELECT count(*) c FROM voter_roll WHERE usu_id = ?')
      .bind(NEW_MEMBER.usu_id).first<{ c: number }>()
    expect(row!.c).toBe(0)
  })

  it('REFUSES to remove someone who has voted', async () => {
    await addVoter(NEW_MEMBER)
    const cookie = await voterSignIn(f.batchId, NEW_MEMBER.usu_id, NEW_MEMBER.last_name)
    await submitBallot(f.batchId, f.electionId, cookie, [f.candidateIds.a])
    expect((await removeVoter(NEW_MEMBER.usu_id)).status).toBe(409)
    const row = await env.DB.prepare('SELECT count(*) c FROM voter_roll WHERE usu_id = ?')
      .bind(NEW_MEMBER.usu_id).first<{ c: number }>()
    expect(row!.c).toBe(1)
  })

  it('REFUSES to remove a member who came from the export', async () => {
    expect((await removeVoter('2400001')).status).toBe(409)
    const row = await env.DB.prepare('SELECT count(*) c FROM voter_roll WHERE usu_id = ?')
      .bind('2400001').first<{ c: number }>()
    expect(row!.c).toBe(1)
  })

  it('keeps the flag when a corrected export later includes them', async () => {
    await addVoter(NEW_MEMBER)
    // the roll import's upsert must not clear added_at_door
    await env.DB.prepare(
      `INSERT INTO voter_roll (batch_id, usu_id, first_name, last_name, eligible) VALUES (?,?,?,?,1)
       ON CONFLICT(batch_id, usu_id) DO UPDATE SET
         first_name = excluded.first_name, last_name = excluded.last_name, eligible = excluded.eligible`,
    ).bind(f.batchId, NEW_MEMBER.usu_id, 'Nina', 'Newjoiner').run()
    const row = await env.DB.prepare('SELECT added_at_door FROM voter_roll WHERE usu_id = ?')
      .bind(NEW_MEMBER.usu_id).first<{ added_at_door: number }>()
    expect(row!.added_at_door).toBe(1)
  })

  it('records the action with NO usu_id and NO name', async () => {
    await addVoter(NEW_MEMBER)
    await removeVoter(NEW_MEMBER.usu_id)
    const rows = await env.DB.prepare(`SELECT action, detail FROM audit_log WHERE action LIKE 'voter.%'`)
      .all<{ action: string; detail: string | null }>()
    expect(rows.results.map((r) => r.action).sort()).toEqual(['voter.add_at_door', 'voter.remove_at_door'])
    for (const r of rows.results) expect(r.detail).toBeNull()
    const all = await env.DB.prepare('SELECT * FROM audit_log').all()
    expect(JSON.stringify(all.results)).not.toMatch(/2400777|Newjoiner/)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run -w @election/api test -- doorVoters`
Expected: FAIL — routes not registered

- [ ] **Step 3: Write minimal implementation**

`apps/api/src/routes/doorVoters.ts`, both routes behind `requireRole('door')`, create route
additionally `rateLimit(RATE_LIMITS.voting)`:

- Zod: `{ usu_id: z.string().regex(/^\d{7,8}$/), first_name: z.string().trim().min(1).max(200),
  last_name: z.string().trim().min(1).max(200) }`. The 7–8 digit shape matches the USU Net Id and what
  the legacy app validated.
- `POST` — a conditional insert so the "already on the roll" check cannot be raced, then the check-in
  and the audit row in the same `DB.batch()`:

```ts
const insertRoll = c.env.DB.prepare(
  `INSERT INTO voter_roll (batch_id, usu_id, first_name, last_name, eligible, added_at_door)
   SELECT ?1, ?2, ?3, ?4, 1, 1
    WHERE NOT EXISTS (SELECT 1 FROM voter_roll WHERE batch_id = ?1 AND usu_id = ?2)`,
).bind(batchId, usuId, firstName, lastName)

const insertCheckIn = c.env.DB.prepare(
  `INSERT INTO check_in (batch_id, usu_id, checked_in_at)
   SELECT ?1, ?2, ?3
    WHERE EXISTS (SELECT 1 FROM voter_roll WHERE batch_id = ?1 AND usu_id = ?2 AND added_at_door = 1)
   ON CONFLICT(batch_id, usu_id) DO NOTHING`,
).bind(batchId, usuId, Date.now())
```

  Run `insertRoll` first. `changes === 0` means the id is already on the roll → **409** with code
  `already_on_roll`; return before writing anything else, so an existing member's name is never
  touched. Otherwise batch `insertCheckIn` with `auditLogStatement({ action: 'voter.add_at_door' })` —
  **no detail** — and return `201 { usu_id, first_name, last_name }`.
- `DELETE` — one conditional statement carrying both refusals:

```sql
DELETE FROM voter_roll
 WHERE batch_id = ?1 AND usu_id = ?2 AND added_at_door = 1
   AND NOT EXISTS (
     SELECT 1 FROM vote_receipt vr
      JOIN election e ON e.id = vr.election_id
     WHERE e.batch_id = ?1 AND vr.usu_id = ?2)
```

  `check_in` cascades from `voter_roll`, but delete it explicitly first in the same batch rather than
  relying on the cascade for ordering. `changes === 0` → read the row once to answer **204** (never
  existed, idempotent) or **409** with `from_export` or `already_voted`.

In `checkIn.ts`, add a fourth subquery to the quorum statement:
`(SELECT count(*) FROM voter_roll WHERE batch_id = ?1 AND added_at_door = 1) AS added_at_door`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run -w @election/api test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/api
git commit -m "feat(api): add a member the export missed, flagged and accountable"
```

---

### Task 4: Provenance and retention — exports, purge, and the record

**Files:**
- Modify: `apps/api/src/routes/exports.ts`, `apps/api/src/routes/purge.ts`, `apps/api/tests/exports.test.ts`, `apps/api/tests/purge.test.ts`, `apps/api/tests/privacy.test.ts`
- Modify: `docs/superpowers/specs/2026-09-16-election-code-rewrite-design.md` (§2 retention, §5 API surface)
- Test: as above

**Interfaces:**
- Consumes: everything from Tasks 1–3
- Produces: `added_at_door` column in both attendance exports; `GET /api/batches/:id/guests.csv`; `DELETE /api/batches/:id/roll` also purges `guest`

**This task is what makes Task 3 defensible rather than merely convenient.** A door-added voter who
cannot be distinguished in the record is an unaccountable voter. And a guest's name is personal data,
so a purge that leaves it behind reinstates exactly the false retention claim that was corrected
earlier in this project.

- [ ] **Step 1: Write the failing test**

Append to `apps/api/tests/exports.test.ts`:

```ts
it('carries added_at_door in the attendance export, so the total has provenance', async () => {
  await SELF.fetch(`https://example.com/api/batches/${f.batchId}/voters`, {
    method: 'POST', headers: { 'content-type': 'application/json', cookie: f.doorCookie },
    body: JSON.stringify({ usu_id: '2400777', first_name: 'Nina', last_name: 'Newjoiner' }),
  })
  const cookie = await voterSignIn(f.batchId, '2400777', 'Newjoiner')
  await submitBallot(f.batchId, f.electionId, cookie, [f.candidateIds.a, f.candidateIds.b])
  await close()
  const text = await (await get(`/elections/${f.electionId}/attendance.csv`)).text()
  expect(text.split('\n')[0]).toBe('usu_id,first_name,last_name,voted_at,recast_count,added_at_door')
  const nina = text.split('\n').find((l) => l.includes('2400777'))
  expect(nina).toMatch(/"1"$/)
})

it('carries added_at_door in the batch attendance export too', async () => {
  await close()
  const text = await (await get('/attendance.csv')).text()
  expect(text.split('\n')[0]).toBe('election_id,election_name,usu_id,first_name,last_name,voted_at,added_at_door')
})

it('exports guests as their own file, not as attendance rows', async () => {
  await SELF.fetch(`https://example.com/api/batches/${f.batchId}/guests`, {
    method: 'POST', headers: { 'content-type': 'application/json', cookie: f.doorCookie },
    body: JSON.stringify({ name: 'Jo Visitor', note: 'observer' }),
  })
  const text = await (await get('/guests.csv')).text()
  expect(text.split('\n')[0]).toBe('name,note,checked_in_at')
  expect(text).toContain('Jo Visitor')
  const attendance = await (await get('/attendance.csv')).text()
  expect(attendance).not.toContain('Jo Visitor')
})
```

Append to `apps/api/tests/purge.test.ts`:

```ts
it('PURGES GUESTS — a guest name is personal data', async () => {
  await SELF.fetch(`https://example.com/api/batches/${f.batchId}/guests`, {
    method: 'POST', headers: { 'content-type': 'application/json', cookie: f.doorCookie },
    body: JSON.stringify({ name: 'Jo Visitor' }),
  })
  await close()
  const res = await purge()
  expect(await res.json()).toMatchObject({ guest: 1 })
  expect(await countOf('guest')).toBe(0)
})

it('purges a door-added member like any other roll row', async () => {
  await SELF.fetch(`https://example.com/api/batches/${f.batchId}/voters`, {
    method: 'POST', headers: { 'content-type': 'application/json', cookie: f.doorCookie },
    body: JSON.stringify({ usu_id: '2400777', first_name: 'Nina', last_name: 'Newjoiner' }),
  })
  await close()
  await purge()
  expect(await countOf('voter_roll')).toBe(0)
})
```

The new `exports.test.ts` cases use `voterSignIn`, which that file does not currently import — add it
to the existing `./helpers.js` import there.

In `apps/api/tests/privacy.test.ts`, add a guest and a door-added member to `runWholeElection`, and add
the four new actions to the inventory in alphabetical order: `guest.add`, `guest.remove`,
`voter.add_at_door`, `voter.remove_at_door`. Note that `runWholeElection` ends with the purge, so the
guest must be added *before* that step or the inventory will not see `guest.add`.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run -w @election/api test -- exports purge privacy`
Expected: FAIL — headers lack the column, purge response lacks `guest`

- [ ] **Step 3: Write minimal implementation**

- `exports.ts` per-election attendance: add `r.added_at_door` to the SELECT and
  `added_at_door` to the header and row mapping. **`COALESCE(r.added_at_door, 0)`** — the join is a
  LEFT JOIN so the roll may be gone after a purge.
- `exports.ts` batch attendance: the same.
- `exports.ts` new route `GET /api/batches/:id/guests.csv` behind `requireRole('officer')`:
  `SELECT name, note, checked_in_at FROM guest WHERE batch_id = ? ORDER BY checked_in_at`, header
  `name,note,checked_in_at`.
- `purge.ts`: count guests alongside the roll and check-ins, add
  `DELETE FROM guest WHERE batch_id = ?` to the same `DB.batch()`, include the count in the
  `roll_purge` detail's `rowsDeleted`, and return `guest` in the response body.
- Spec §2 retention: name `guest` among what is purged, and note that `voter_roll.added_at_door`
  distinguishes a door-added member in the attendance export.
- Spec §5: add the five new routes under the door and officer sections.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run -w @election/api test && npm run -w @election/api typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/api docs/superpowers/specs
git commit -m "feat(api): guests purged, door additions traceable in the attendance record"
```

---

## Success criteria for Plan 2d

- `npm run -w @election/api test` passes with no skipped tests; typecheck clean; dependencies unchanged.
- **A guest cannot vote and cannot be checked in as a voter**, verified against the API.
- **A door-added member can sign in and cast a ballot** — the feature works.
- A `usu_id` already on the roll is refused, and that member's name is left untouched.
- A door-added member cannot be removed once they have voted; a member from the export cannot be removed at all.
- `added_at_door` survives a re-import that includes the member.
- `GET /quorum` returns `{checked_in, eligible, guests, added_at_door}` — guests never move the ratio.
- Both attendance exports carry `added_at_door`; guests are a separate file.
- After the purge, `guest` is empty, and the response reports how many were deleted.
- **No `audit_log` row anywhere contains a guest's name or a door-added member's `usu_id`**, asserted over the whole table.

## What Plan 2d does NOT cover

The door UI for either action — that is Plan 3b (`docs/superpowers/specs/2026-09-21-frontends-design.md`
§5.3), which must present them as two separate buttons with different wording, because one catch-all
button would let a volunteer grant a vote by accident.
