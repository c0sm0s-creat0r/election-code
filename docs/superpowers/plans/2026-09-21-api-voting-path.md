# apps/api Voting Path Implementation Plan (Plan 2b)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Everything needed to actually run an election — import the member roll, check people in at the door, open voting, and record ballots that cannot be double-cast or traced back to the voter.

**Architecture:** Hono on Workers over the Plan 2a foundation. D1 for data, KV for rate limits, `@election/core` for validation. Every mutation that must be atomic goes through `DB.batch()`.

**Tech Stack:** Hono, Zod, `@election/core`, Cloudflare D1 + KV, Vitest with `@cloudflare/vitest-pool-workers`.

**Spec:** `docs/superpowers/specs/2026-09-16-election-code-rewrite-design.md` — §2 (data model), §3 (ballot validity), §4 (lifecycle and flows), §5 (API surface), §6 (security posture)
**Handoff — READ §6b BEFORE TASK 1:** `docs/superpowers/HANDOFF.md`

**Plan 2b of 3 for `apps/api`.** Plan 2a (foundation: schema, hashing, sessions, batch provisioning, sign-in) is complete at 111/111. Plan 2c covers close/seal/count, tie-break override, exports, R2 logos and the post-AGM roll purge.

## Global Constraints

- **`apps/api` runtime dependencies stay exactly `hono`, `zod`, `@election/core`.** A KV binding is configuration, not a dependency. Anything else needs justification in the commit message.
- **No ORM.** D1 prepared statements only. `0001_initial.sql` is **immutable** — it is applied to the production database; all schema changes go in a new numbered migration.
- TypeScript `strict`, `noUncheckedIndexedAccess`, `noUnusedLocals`. No `any` in exported signatures.
- Every request body validated with Zod at the boundary. Ids from `crypto.randomUUID()`.
- **Every gated route is `/api/batches/:id/...`** — `requireRole` binds the literal param name `id`. A route written `:batchId` yields a middleware that denies everything.
- **`AuditEntry.detail` is an allow-list** (`src/db/audit.ts`). Adding an audited action means adding a variant. The rule it enforces: **never a usu_id, never a ballot id, never a preference list.** `audit_log` is undeletable by construction, and `audit_log.id` is AUTOINCREMENT with a timestamp — a row carrying a ballot id or a usu_id beside a ballot event rebuilds exactly the correlation `WITHOUT ROWID` and the absent `ballot.cast_at` exist to prevent.
- **A session cookie is never proof of eligibility.** See Task 6.
- No password, hash, token or secret in any response body, error or log line.
- TDD throughout: failing test, watch it fail, implement, commit.

---

### Task 1: KV rate limiting

Foundational: Tasks 2–7 all attach limits. Also closes the unauthenticated-D1-write on `POST /api/batches` that Plan 2a's denied-attempt audit introduced.

**Files:**
- Create: `apps/api/src/middleware/rateLimit.ts`
- Modify: `apps/api/wrangler.jsonc` (KV binding), `apps/api/src/index.ts` (`Env`), `apps/api/vitest.config.ts` (test binding)
- Modify: `apps/api/src/routes/auth.ts`, `apps/api/src/routes/batches.ts`
- Test: `apps/api/tests/rateLimit.test.ts`

**Interfaces:**
- Consumes: `Env`
- Produces: `rateLimit(opts: { name: string; limit: number; windowSeconds: number; key?: (c) => string })` Hono middleware; `RATE_LIMITS` constants

**The sizing decision, which matters more than the mechanism.** An AGM is one room on one wifi network, so **every voter shares a source IP**, and Australian mobile carriers use CGNAT on top. A tight per-IP limit does not stop an attacker, it locks out the room. So:

| Route | Limit | Why |
| --- | --- | --- |
| `POST /api/batches` | 10 / hour / IP | Operator-only, from anywhere. Tight is safe. |
| `officer/session`, `door/session` | 30 / 10 min / IP | ~210k PBKDF2 iterations *and* an audit row per failure. Loose enough for a committee retyping a shared password, tight enough that the audit trail cannot be flooded until real entries are unreadable. |
| roll lookup, voter sign-in, ballot submission | 300 / 10 min / IP | **Deliberately loose.** Integrity comes from the roll, the check-in and the `vote_receipt` primary key — never from the rate limit. A limit that blocks a queue of 200 people breaks the election; one that permits them cannot forge a ballot. |

The short window matters: a stall recovers in ten minutes rather than an hour.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, beforeEach } from 'vitest'
import { SELF, env, applyD1Migrations } from 'cloudflare:test'

const KEY = 'super-secret-test-key'
const body = (slug: string) => JSON.stringify({
  name: 'N', slug, officer_password: 'officer-password-1', door_password: 'door-password-1',
  branding: { title: 't', org_name: 'o', accent_color: '#000000', logo_url: '' },
})

beforeEach(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS)
  await env.DB.prepare('DELETE FROM batch').run()
  await env.DB.prepare('DELETE FROM audit_log').run()
  for (const k of (await env.RATE_LIMIT.list()).keys) await env.RATE_LIMIT.delete(k.name)
})

const create = (slug: string, ip = '203.0.113.1') =>
  SELF.fetch('https://example.com/api/batches', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-super-admin-key': KEY, 'cf-connecting-ip': ip },
    body: body(slug),
  })

describe('rate limiting', () => {
  it('allows requests under the limit', async () => {
    expect((await create('a')).status).toBe(201)
    expect((await create('b')).status).toBe(201)
  })

  it('returns 429 once the limit is exceeded', async () => {
    for (let i = 0; i < 10; i++) await create(`s${i}`)
    const res = await create('over-the-limit')
    expect(res.status).toBe(429)
    expect(await res.json()).toMatchObject({ error: 'rate_limited' })
  })

  it('sets Retry-After on a 429', async () => {
    for (let i = 0; i < 10; i++) await create(`t${i}`)
    const res = await create('t-over')
    expect(Number(res.headers.get('retry-after'))).toBeGreaterThan(0)
  })

  it('counts per IP, so one blocked client does not block another', async () => {
    for (let i = 0; i < 10; i++) await create(`u${i}`, '203.0.113.1')
    expect((await create('u-over', '203.0.113.1')).status).toBe(429)
    expect((await create('other-ip', '198.51.100.7')).status).toBe(201)
  })

  it('limits the sign-in route separately from batch creation', async () => {
    // exhausting one must not exhaust the other
    for (let i = 0; i < 10; i++) await create(`v${i}`)
    const res = await SELF.fetch('https://example.com/api/batches/nope/officer/session', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.1' },
      body: JSON.stringify({ password: 'x' }),
    })
    expect(res.status).not.toBe(429)
  })

  it('rejects before doing the expensive work', async () => {
    // a 429 on sign-in must not have run PBKDF2 or written an audit row
    for (let i = 0; i < 30; i++) {
      await SELF.fetch('https://example.com/api/batches/nope/officer/session', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'cf-connecting-ip': '198.51.100.9' },
        body: JSON.stringify({ password: 'x' }),
      })
    }
    const before = await env.DB.prepare(`SELECT count(*) c FROM audit_log`).first<{ c: number }>()
    const res = await SELF.fetch('https://example.com/api/batches/nope/officer/session', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'cf-connecting-ip': '198.51.100.9' },
      body: JSON.stringify({ password: 'x' }),
    })
    expect(res.status).toBe(429)
    const after = await env.DB.prepare(`SELECT count(*) c FROM audit_log`).first<{ c: number }>()
    expect(after!.c).toBe(before!.c)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run -w @election/api test -- rateLimit`
Expected: FAIL — `env.RATE_LIMIT` undefined

- [ ] **Step 3: Write minimal implementation**

`apps/api/src/middleware/rateLimit.ts`:

```ts
import type { Context, MiddlewareHandler } from 'hono'
import type { Env } from '../index.js'

/**
 * Fixed-window counter in KV.
 *
 * Sizing is deliberate and is documented per route in RATE_LIMITS below. The
 * governing fact: an AGM is one room on one wifi network, and Australian
 * mobile carriers use CGNAT, so every voter shares a source IP. A tight
 * per-IP limit does not stop an attacker — it locks out the room. Integrity
 * for voting comes from the roll, the check-in and the vote_receipt primary
 * key, never from a rate limit.
 *
 * Fixed windows can admit up to 2x the limit across a boundary. That is
 * accepted: these limits exist to stop runaway cost and audit-log flooding,
 * not to be a precise quota.
 */
export type RateLimitOptions = {
  /** Namespace, so one route's budget is not another's. */
  name: string
  limit: number
  windowSeconds: number
}

export const RATE_LIMITS = {
  /** Operator-only, from anywhere. Tight is safe. */
  batchCreate: { name: 'batch-create', limit: 10, windowSeconds: 3600 },
  /** ~210k PBKDF2 iterations AND an audit row per failure. */
  staffSignIn: { name: 'staff-signin', limit: 30, windowSeconds: 600 },
  /** Deliberately loose — a whole AGM shares this IP. */
  voting: { name: 'voting', limit: 300, windowSeconds: 600 },
} as const satisfies Record<string, RateLimitOptions>

const clientIp = (c: Context): string =>
  c.req.header('cf-connecting-ip') ?? c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown'

export function rateLimit(opts: RateLimitOptions): MiddlewareHandler<{ Bindings: Env }> {
  return async (c, next) => {
    const window = Math.floor(Date.now() / 1000 / opts.windowSeconds)
    const key = `rl:${opts.name}:${window}:${clientIp(c)}`

    const current = Number((await c.env.RATE_LIMIT.get(key)) ?? '0')
    if (current >= opts.limit) {
      const resetAt = (window + 1) * opts.windowSeconds
      const retryAfter = Math.max(1, resetAt - Math.floor(Date.now() / 1000))
      return c.json({ error: 'rate_limited', retry_after: retryAfter }, 429, {
        'retry-after': String(retryAfter),
      })
    }

    // Read-then-write is racy under concurrency; an over-count of a few under
    // load is acceptable for a limit whose purpose is cost control.
    await c.env.RATE_LIMIT.put(key, String(current + 1), {
      expirationTtl: opts.windowSeconds * 2,
    })

    await next()
  }
}
```

Add to `Env` in `src/index.ts`: `RATE_LIMIT: KVNamespace`.

Add to `wrangler.jsonc`:

```jsonc
  "kv_namespaces": [
    { "binding": "RATE_LIMIT", "id": "PLACEHOLDER_SET_BY_WRANGLER" }
  ],
```

Add to `vitest.config.ts` miniflare options: `kvNamespaces: ['RATE_LIMIT']`.

Apply in `routes/batches.ts` to `POST /api/batches` and in `routes/auth.ts` to both sign-in routes — **before** any other work, so a 429 costs no PBKDF2 and writes no audit row.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run -w @election/api test`
Expected: PASS, all existing 111 plus the new ones

- [ ] **Step 5: Commit**

```bash
git add apps/api
git commit -m "feat(api): KV rate limiting, sized for a room sharing one IP"
```

---

### Task 2: Roll import — preview and commit

**Files:**
- Create: `apps/api/src/routes/roll.ts`
- Modify: `apps/api/src/index.ts`, `apps/api/src/db/audit.ts` (if a variant is missing)
- Test: `apps/api/tests/roll.test.ts`
- Test fixture: `apps/api/tests/fixtures/usu-sample.csv` (copy the shape from `packages/core/tests/fixtures/usu-sample.csv` — **invented names and ids only**)

**Interfaces:**
- Consumes: `parseUsuExport`, `RollMember`, `ImportResult` from `@election/core`; `requireRole('officer')`; `recordAudit`
- Produces: `POST /api/batches/:id/roll/preview`, `POST /api/batches/:id/roll`

**Why preview then commit.** The officer sees "1,298 eligible, 4 excluded, 0 skipped" *before* anything is written. A malformed export that silently drops members is the failure this two-step exists to catch — `parseUsuExport` already counts `skipped` for exactly that reason.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, beforeEach } from 'vitest'
import { SELF, env, applyD1Migrations } from 'cloudflare:test'
import { readFileSync } from 'node:fs'

const KEY = 'super-secret-test-key'
const csv = readFileSync(new URL('./fixtures/usu-sample.csv', import.meta.url), 'utf8')
let batchId = ''
let officerCookie = ''

beforeEach(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS)
  for (const t of ['voter_roll', 'check_in', 'audit_log', 'batch']) {
    await env.DB.prepare(`DELETE FROM ${t}`).run()
  }
  for (const k of (await env.RATE_LIMIT.list()).keys) await env.RATE_LIMIT.delete(k.name)
  const res = await SELF.fetch('https://example.com/api/batches', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-super-admin-key': KEY },
    body: JSON.stringify({
      name: 'N', slug: 's', officer_password: 'officer-password-1', door_password: 'door-password-1',
      branding: { title: 't', org_name: 'o', accent_color: '#000000', logo_url: '' },
    }),
  })
  batchId = (await res.json() as { id: string }).id
  const si = await SELF.fetch(`https://example.com/api/batches/${batchId}/officer/session`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: 'officer-password-1' }),
  })
  officerCookie = (si.headers.get('set-cookie') ?? '').split(';')[0]!
})

const upload = (path: string, cookie = officerCookie) => {
  const fd = new FormData()
  fd.append('file', new File([csv], 'members.csv', { type: 'text/csv' }))
  return SELF.fetch(`https://example.com/api/batches/${batchId}${path}`, {
    method: 'POST', headers: { cookie }, body: fd,
  })
}

describe('roll import', () => {
  it('requires an officer session', async () => {
    expect((await upload('/roll/preview', '')).status).toBe(401)
  })

  it('previews counts without writing anything', async () => {
    const res = await upload('/roll/preview')
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ total: 6, eligible: 4, excluded: 2, skipped: 0, shifted: true })
    const row = await env.DB.prepare('SELECT count(*) c FROM voter_roll').first<{ c: number }>()
    expect(row!.c).toBe(0)
  })

  it('commits the roll', async () => {
    const res = await upload('/roll')
    expect(res.status).toBe(200)
    const row = await env.DB.prepare('SELECT count(*) c FROM voter_roll WHERE batch_id = ?').bind(batchId).first<{ c: number }>()
    expect(row!.c).toBe(6)
  })

  it('marks departed members ineligible rather than dropping them', async () => {
    await upload('/roll')
    const row = await env.DB.prepare('SELECT count(*) c FROM voter_roll WHERE batch_id = ? AND eligible = 0').bind(batchId).first<{ c: number }>()
    expect(row!.c).toBe(2)
  })

  it('stores only id and name — no email, no membership data', async () => {
    await upload('/roll')
    const cols = await env.DB.prepare('PRAGMA table_info(voter_roll)').all<{ name: string }>()
    expect(cols.results.map((r) => r.name).sort()).toEqual(['batch_id', 'eligible', 'first_name', 'last_name', 'usu_id'])
  })

  it('is idempotent — re-importing does not duplicate', async () => {
    await upload('/roll')
    await upload('/roll')
    const row = await env.DB.prepare('SELECT count(*) c FROM voter_roll WHERE batch_id = ?').bind(batchId).first<{ c: number }>()
    expect(row!.c).toBe(6)
  })

  it('records an audit row carrying counts, never identities', async () => {
    await upload('/roll')
    const row = await env.DB.prepare(`SELECT action, detail FROM audit_log WHERE action = 'roll.import'`).first<{ action: string; detail: string }>()
    expect(row).toBeTruthy()
    expect(row!.detail).not.toMatch(/\d{7}/)   // no usu_id
    expect(JSON.parse(row!.detail)).toMatchObject({ kind: 'roll_import', eligible: 4, excluded: 2 })
  })

  it('rejects a corrupt export without writing a partial roll', async () => {
    const fd = new FormData()
    fd.append('file', new File(['"Net Id","First Name"\n"1","unterminated'], 'bad.csv', { type: 'text/csv' }))
    const res = await SELF.fetch(`https://example.com/api/batches/${batchId}/roll`, {
      method: 'POST', headers: { cookie: officerCookie }, body: fd,
    })
    expect(res.status).toBe(400)
    const row = await env.DB.prepare('SELECT count(*) c FROM voter_roll').first<{ c: number }>()
    expect(row!.c).toBe(0)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run -w @election/api test -- roll`
Expected: FAIL — routes not registered

- [ ] **Step 3: Write minimal implementation**

`apps/api/src/routes/roll.ts`, both routes behind `requireRole('officer')`:

- Read the uploaded file from `await c.req.formData()`, reject anything over 2 MB (the real export is ~256 KB) and anything that is not a file, with 400.
- Call `parseUsuExport(text)`. **Let its throw become a 400, not a 500** — an unterminated quoted field means the export is corrupt, and the message already says no roll was imported.
- **Preview** returns `{ total, eligible, excluded, skipped, shifted }` and writes nothing.
  `ImportResult` has no `total` — it is `members.length`, i.e. rows actually importable, which is
  why `skipped` is reported beside it rather than folded into it.
- **Commit** writes every member with `INSERT INTO voter_roll (batch_id, usu_id, first_name, last_name, eligible) VALUES (?,?,?,?,?) ON CONFLICT(batch_id, usu_id) DO UPDATE SET first_name=excluded.first_name, last_name=excluded.last_name, eligible=excluded.eligible`, chunked into `DB.batch()` calls of at most 100 statements (D1 has a per-call statement limit and the real roll is 1,302 rows), plus one `auditLogStatement` for `roll.import`.
- Add the `roll_import` variant to `AuditDetail` if absent.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run -w @election/api test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/api
git commit -m "feat(api): USU roll import with a preview before commit"
```

---

### Task 3: Door check-in and quorum

**Files:**
- Create: `apps/api/src/routes/checkIn.ts`
- Modify: `apps/api/src/index.ts`
- Test: `apps/api/tests/checkIn.test.ts`

**Interfaces:**
- Consumes: `requireRole('door')`, `recordAudit`
- Produces: `GET /api/batches/:id/roll`, `POST /api/batches/:id/check-in`, `DELETE /api/batches/:id/check-in/:usuId`, `GET /api/batches/:id/quorum`

**Why the roll is fetched whole.** ~1,300 rows at roughly 40 bytes is ~50 KB. The door app fetches it once and filters client-side on every keystroke, so search is instant and keeps working if venue wifi drops mid-queue. A server round-trip per keystroke is the wrong shape for a queue of people.

**This role must not reach anything else.** The door session grants check-in and the quorum count. Nothing about elections, candidates or any tally.

- [ ] **Step 1: Write the failing test**

```ts
// setup as in Task 2, plus a door sign-in and a committed roll
describe('door check-in', () => {
  it('requires a door session', async () => {
    expect((await SELF.fetch(`https://example.com/api/batches/${batchId}/roll`)).status).toBe(401)
  })

  it('rejects an officer session on a door route', async () => {
    const res = await SELF.fetch(`https://example.com/api/batches/${batchId}/roll`, { headers: { cookie: officerCookie } })
    expect(res.status).toBe(403)
  })

  it('returns the roll with id, name and eligibility only', async () => {
    const res = await SELF.fetch(`https://example.com/api/batches/${batchId}/roll`, { headers: { cookie: doorCookie } })
    expect(res.status).toBe(200)
    const rows = await res.json() as Array<Record<string, unknown>>
    expect(rows).toHaveLength(6)
    expect(Object.keys(rows[0]!).sort()).toEqual(['checked_in_at', 'eligible', 'first_name', 'last_name', 'usu_id'])
  })

  it('checks a member in', async () => {
    const res = await checkIn('2400001')
    expect(res.status).toBe(200)
    const row = await env.DB.prepare('SELECT count(*) c FROM check_in WHERE batch_id = ?').bind(batchId).first<{ c: number }>()
    expect(row!.c).toBe(1)
  })

  it('is idempotent — checking in twice is not an error and does not duplicate', async () => {
    await checkIn('2400001')
    expect((await checkIn('2400001')).status).toBe(200)
    const row = await env.DB.prepare('SELECT count(*) c FROM check_in').first<{ c: number }>()
    expect(row!.c).toBe(1)
  })

  it('refuses a member who is not on the roll', async () => {
    expect((await checkIn('9999999')).status).toBe(404)
  })

  it('refuses a member marked ineligible', async () => {
    expect((await checkIn(INELIGIBLE_USU_ID)).status).toBe(403)
  })

  it('un-checks a member in', async () => {
    await checkIn('2400001')
    const res = await SELF.fetch(`https://example.com/api/batches/${batchId}/check-in/2400001`, {
      method: 'DELETE', headers: { cookie: doorCookie },
    })
    expect(res.status).toBe(204)
    const row = await env.DB.prepare('SELECT count(*) c FROM check_in').first<{ c: number }>()
    expect(row!.c).toBe(0)
  })

  it('reports quorum as checked-in over eligible', async () => {
    await checkIn('2400001')
    await checkIn('2400002')
    const res = await SELF.fetch(`https://example.com/api/batches/${batchId}/quorum`, { headers: { cookie: doorCookie } })
    expect(await res.json()).toEqual({ checked_in: 2, eligible: 4 })
  })

  it('never lets the door role reach an officer route', async () => {
    const res = await SELF.fetch(`https://example.com/api/batches/${batchId}/officer/ping`, { headers: { cookie: doorCookie } })
    expect(res.status).toBe(403)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run -w @election/api test -- checkIn`
Expected: FAIL — routes not registered

- [ ] **Step 3: Write minimal implementation**

All four routes behind `requireRole('door')`. `GET /roll` additionally carries
`rateLimit(RATE_LIMITS.voting)` — spec §6 names "roll lookup" as one of the three surfaces that
must be limited, and a 50 KB response is the largest thing an authenticated door tablet can ask
for in a loop.

- `GET /roll` — `SELECT vr.usu_id, vr.first_name, vr.last_name, vr.eligible, ci.checked_in_at FROM voter_roll vr LEFT JOIN check_in ci ON ci.batch_id = vr.batch_id AND ci.usu_id = vr.usu_id WHERE vr.batch_id = ? ORDER BY vr.last_name, vr.first_name`.
- `POST /check-in` — Zod `{ usu_id: string }`. Insert conditionally so the roll check cannot be raced:
  `INSERT INTO check_in (batch_id, usu_id, checked_in_at) SELECT ?1, ?2, ?3 WHERE EXISTS (SELECT 1 FROM voter_roll WHERE batch_id = ?1 AND usu_id = ?2 AND eligible = 1) ON CONFLICT(batch_id, usu_id) DO NOTHING`.
  Then distinguish the outcomes: if `changes === 0`, query the roll once to answer 404 (absent) versus 403 (ineligible) versus 200 (already checked in).
- `DELETE /check-in/:usuId` — 204, idempotent.
- `GET /quorum` — two counts.
- Audit `check_in.add` / `check_in.remove` with **no detail at all** — a usu_id must never reach `audit_log`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run -w @election/api test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/api
git commit -m "feat(api): door check-in, quorum, and a client-side-filterable roll"
```

---

### Task 4: Election lifecycle

**Files:**
- Create: `apps/api/src/routes/elections.ts`
- Modify: `apps/api/src/index.ts`
- Test: `apps/api/tests/elections.test.ts`

**Interfaces:**
- Consumes: `requireRole('officer')`, `recordAudit`
- Produces: `POST /api/batches/:id/elections`, `POST|PATCH|DELETE .../elections/:eid/candidates[/:cid]`, `POST .../elections/:eid/open`, `GET /api/batches/:id/elections`

**The two rules that carry the weight** (spec §4):

- **Candidates freeze at `open`.** The legacy `add_candidate` worked at any time. Adding a candidate after fifty ballots means those fifty voters never had the chance to rank them, and their ballots are silently incomparable.
- **No tally exists until `closed`.** An officer who can watch the result develop and choose when to stop makes every other control decorative. Turnout is visible while open; the count is not. (Closing and counting are Plan 2c; this task must make the states enforceable.)

**Opening is refused with no candidates.** `minimumPreferences` is `Math.max(1, min(seats, candidateCount))`, so the library is safe standalone — but an election with no candidates must never open.

- [ ] **Step 1: Write the failing test**

```ts
describe('election lifecycle', () => {
  it('creates an election in draft', async () => {
    const res = await createElection({ name: 'President', seats: 1 })
    expect(res.status).toBe(201)
    expect(await res.json()).toMatchObject({ name: 'President', seats: 1, status: 'draft' })
  })

  it('rejects seats below 1', async () => {
    expect((await createElection({ name: 'x', seats: 0 })).status).toBe(400)
  })

  it('adds candidates while in draft', async () => {
    const eid = await newElection()
    expect((await addCandidate(eid, 'Alex')).status).toBe(201)
  })

  it('refuses to open an election with no candidates', async () => {
    const eid = await newElection()
    const res = await open(eid)
    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({ error: expect.stringMatching(/candidate/i) })
  })

  it('refuses to open with fewer candidates than seats', async () => {
    const eid = await newElection({ seats: 3 })
    await addCandidate(eid, 'Only One')
    expect((await open(eid)).status).toBe(409)
  })

  it('opens an election', async () => {
    const eid = await newElection()
    await addCandidate(eid, 'Alex'); await addCandidate(eid, 'Bo')
    expect((await open(eid)).status).toBe(200)
  })

  it('FREEZES candidates once open', async () => {
    const eid = await openElection()
    expect((await addCandidate(eid, 'Late Entry')).status).toBe(409)
  })

  it('refuses to edit or delete a candidate once open', async () => {
    const { eid, cid } = await openElectionWithCandidate()
    expect((await patchCandidate(eid, cid, 'Renamed')).status).toBe(409)
    expect((await deleteCandidate(eid, cid)).status).toBe(409)
  })

  it('refuses to open an election twice', async () => {
    const eid = await openElection()
    expect((await open(eid)).status).toBe(409)
  })

  it('never exposes ballots or attendees on the public election listing', async () => {
    await openElection()
    const res = await SELF.fetch(`https://example.com/api/batches/${batchId}/elections`)
    expect(res.status).toBe(200)
    const list = await res.json() as Array<Record<string, unknown>>
    expect(Object.keys(list[0]!).sort()).toEqual(['candidates', 'id', 'name', 'seats', 'status'])
  })

  it('hides draft elections from the public listing', async () => {
    await newElection()
    const res = await SELF.fetch(`https://example.com/api/batches/${batchId}/elections`)
    expect(await res.json()).toEqual([])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run -w @election/api test -- elections`
Expected: FAIL — routes not registered

- [ ] **Step 3: Write minimal implementation**

- Candidate mutations guard on status: `WHERE election_id = ? AND (SELECT status FROM election WHERE id = ?) = 'draft'`, and a `changes === 0` result becomes 409 after confirming the election exists.
- `POST /open` — transition `draft → open` conditionally: `UPDATE election SET status='open', opened_at=? WHERE id=? AND batch_id=? AND status='draft' AND (SELECT count(*) FROM candidate WHERE election_id=?) >= seats`. `changes === 0` → 409.
- `GET /elections` is **public** and returns only `{id, name, seats, status, candidates}` for elections in `open` or `closed`. **Never ballots, never attendees** — that was the legacy hole in spec §6.
- Audit `election.create`, `candidate.add`, `election.open` with the `election_open` detail variant.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run -w @election/api test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/api
git commit -m "feat(api): election lifecycle with candidates frozen at open"
```

---

### Task 5: Voter sign-in

**Files:**
- Create: `apps/api/src/routes/voter.ts`
- Modify: `apps/api/src/index.ts`
- Test: `apps/api/tests/voter.test.ts`

**Interfaces:**
- Consumes: `signSession`, `cookieName`, `cookieOptions`, `rateLimit(RATE_LIMITS.voting)`
- Produces: `POST /api/batches/:id/voter/session`

**Why USU id *and* surname.** Looking a voter up by id alone and echoing their name back is an enumeration oracle over a seven-digit space — anyone could map ids to real names. Requiring the surname gives nothing away on a wrong guess. This is the same reasoning as the `DUMMY_HASH` on staff sign-in.

**The voter session carries `subject`.** `Session` is a discriminated union: `{ role: 'voter' }` cannot typecheck without `subject: string`. The subject is the `usu_id`, and Task 6 reads it — but never trusts it as proof of eligibility.

- [ ] **Step 1: Write the failing test**

```ts
describe('voter sign-in', () => {
  it('accepts a checked-in member with matching surname', async () => {
    await checkIn('2400001')
    const res = await voterSignIn('2400001', 'Lovelace')
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ first_name: 'Ada' })
    expect(res.headers.get('set-cookie') ?? '').toMatch(/HttpOnly/i)
  })

  it('is case-insensitive on the surname', async () => {
    await checkIn('2400001')
    expect((await voterSignIn('2400001', 'LOVELACE')).status).toBe(200)
  })

  it('refuses a wrong surname', async () => {
    await checkIn('2400001')
    expect((await voterSignIn('2400001', 'Wrong')).status).toBe(401)
  })

  it('refuses a member who is not checked in', async () => {
    expect((await voterSignIn('2400001', 'Lovelace')).status).toBe(403)
  })

  it('refuses a member marked ineligible', async () => {
    expect((await voterSignIn(INELIGIBLE_USU_ID, INELIGIBLE_SURNAME)).status).toBe(403)
  })

  it('gives an unknown id and a wrong surname the same answer', async () => {
    const unknown = await voterSignIn('9999999', 'Nobody')
    const wrong = await voterSignIn('2400001', 'Wrong')
    expect(unknown.status).toBe(wrong.status)
    expect(await unknown.json()).toEqual(await wrong.json())
  })

  it('never returns another member\'s name on a wrong surname', async () => {
    await checkIn('2400001')
    const text = await (await voterSignIn('2400001', 'Wrong')).text()
    expect(text).not.toMatch(/Ada|Lovelace/)
  })

  it('issues a voter session scoped to this batch', async () => {
    await checkIn('2400001')
    const cookie = (await voterSignIn('2400001', 'Lovelace')).headers.get('set-cookie') ?? ''
    expect(cookie).toMatch(new RegExp(`es_voter_${batchId}=`))
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run -w @election/api test -- voter`
Expected: FAIL — route not registered

- [ ] **Step 3: Write minimal implementation**

One query joining `voter_roll` and `check_in`, comparing `lower(last_name) = lower(?)`. Outcomes:

- No row, or surname mismatch → **401**, identical body either way.
- Row found, `eligible = 0`, or no `check_in` → **403** with a code the frontend can act on (`not_checked_in` / `ineligible`), because these are recoverable at the door and the voter needs to know which.
- Otherwise sign a `Session` with `role: 'voter'`, `subject: usu_id`, a 4-hour expiry, set the cookie, return `{ first_name }`.

Rate-limited with `RATE_LIMITS.voting`. Audit `session.voter.ok`/`.fail` with **no detail** — a usu_id must never reach `audit_log`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run -w @election/api test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/api
git commit -m "feat(api): voter sign-in by USU id and surname"
```

---

### Task 6: Ballot submission

The most important task in this plan. Read all of it before writing anything.

**Files:**
- Create: `apps/api/src/routes/ballots.ts`
- Create: `apps/api/migrations/0002_live_receipt_hash.sql` (`0001` is applied to production and is immutable)
- Modify: `apps/api/src/index.ts`, `apps/api/src/db/types.ts`
- Test: `apps/api/tests/ballots.test.ts`

**Interfaces:**
- Consumes: `requireSession`, `validateBallot` and `minimumPreferences` from `@election/core`
- Produces: `POST /api/batches/:id/elections/:eid/ballots`

**A session cookie is not proof of eligibility.** A voter session proves only that someone passed id + surname at some earlier moment. An officer can un-check-in a voter *after* their cookie was issued (Task 3's `DELETE /check-in/:usuId`), and Plan 2c's roll purge deletes rows while cookies stay valid for their full TTL. **Eligibility is therefore re-verified on every submission, inside the transaction.**

**And that re-check must not be a read-then-write.** A separate `SELECT` before the insert reintroduces exactly the race spec §6 claims to fix in the legacy `attendee.voted` flag — two tabs both read "not yet voted", both proceed. Fold the check into the inserts with `WHERE EXISTS`.

**Both statements carry the same `EXISTS` clause.** If eligibility fails, both insert zero rows — no ballot, no receipt, and `changes === 0` tells you to answer 403. If the voter has already voted, the `vote_receipt` primary key throws and D1 rolls the whole batch back, so no orphan ballot can exist. Writing the ballot unconditionally and the receipt conditionally would leave a ballot with no receipt.

**The ballot row carries no voter reference and no timestamp.** That is the secret ballot: `id` is a random UUID in a `WITHOUT ROWID` table, so physical order is random rather than insertion order, and with no `cast_at` there is no join key against `vote_receipt.voted_at`.

- [ ] **Step 1: Write the failing test**

```ts
describe('ballot submission', () => {
  it('records a ballot and returns a receipt token', async () => {
    const res = await submit(['a', 'b'])
    expect(res.status).toBe(201)
    const body = await res.json() as { receipt_token: string }
    expect(body.receipt_token).toMatch(/^[0-9a-f-]{36}$/)
  })

  it('stores no voter reference and no timestamp on the ballot', async () => {
    await submit(['a', 'b'])
    const cols = await env.DB.prepare('PRAGMA table_info(ballot)').all<{ name: string }>()
    expect(cols.results.map((r) => r.name).sort()).toEqual(['election_id', 'id', 'preferences', 'receipt_hash', 'voided'])
  })

  it('stores the receipt as a hash, never the token', async () => {
    const token = (await (await submit(['a', 'b'])).json() as { receipt_token: string }).receipt_token
    const row = await env.DB.prepare('SELECT receipt_hash FROM ballot').first<{ receipt_hash: string }>()
    expect(row!.receipt_hash).not.toBe(token)
    expect(row!.receipt_hash).toMatch(/^[0-9a-f]{64}$/)
  })

  it('REFUSES A SECOND BALLOT from the same voter', async () => {
    await submit(['a', 'b'])
    expect((await submit(['b', 'a'])).status).toBe(409)
  })

  it('leaves exactly one ballot after a refused second submission', async () => {
    await submit(['a', 'b'])
    await submit(['b', 'a'])
    const row = await env.DB.prepare('SELECT count(*) c FROM ballot').first<{ c: number }>()
    expect(row!.c).toBe(1)
  })

  it('refuses a voter who was un-checked-in after signing in', async () => {
    // the cookie is still valid; eligibility is not
    await SELF.fetch(`https://example.com/api/batches/${batchId}/check-in/2400001`, {
      method: 'DELETE', headers: { cookie: doorCookie },
    })
    expect((await submit(['a', 'b'])).status).toBe(403)
  })

  it('writes no ballot when eligibility fails', async () => {
    await SELF.fetch(`https://example.com/api/batches/${batchId}/check-in/2400001`, {
      method: 'DELETE', headers: { cookie: doorCookie },
    })
    await submit(['a', 'b'])
    const row = await env.DB.prepare('SELECT count(*) c FROM ballot').first<{ c: number }>()
    expect(row!.c).toBe(0)
  })

  it('refuses fewer preferences than seats', async () => {
    // seats = 2 for this fixture
    const res = await submit(['a'])
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ error: expect.stringMatching(/at least 2/) })
  })

  it('refuses an unknown candidate', async () => {
    expect((await submit(['a', 'zzz'])).status).toBe(400)
  })

  it('refuses a duplicated preference', async () => {
    expect((await submit(['a', 'a'])).status).toBe(400)
  })

  it('refuses a ballot in a draft election', async () => {
    expect((await submitTo(draftElectionId, ['a', 'b'])).status).toBe(409)
  })

  it('refuses a ballot in a closed election', async () => {
    expect((await submitTo(closedElectionId, ['a', 'b'])).status).toBe(409)
  })

  it('requires a voter session', async () => {
    expect((await submit(['a', 'b'], '')).status).toBe(401)
  })

  it('refuses an officer session', async () => {
    expect((await submit(['a', 'b'], officerCookie)).status).toBe(403)
  })

  it('writes an audit row with no usu_id and no ballot id', async () => {
    await submit(['a', 'b'])
    const rows = await env.DB.prepare(`SELECT detail FROM audit_log WHERE action LIKE 'ballot%'`).all<{ detail: string | null }>()
    for (const r of rows.results) {
      expect(r.detail ?? '').not.toMatch(/\d{7}/)
      expect(r.detail ?? '').not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}/)
    }
  })

  it('records the mark-off on the roll, and only that', async () => {
    await submit(['a', 'b'])
    const row = await env.DB.prepare('SELECT usu_id, recast_count FROM vote_receipt').first<{ usu_id: string; recast_count: number }>()
    expect(row).toMatchObject({ usu_id: '2400001', recast_count: 0 })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run -w @election/api test -- ballots`
Expected: FAIL — route not registered

- [ ] **Step 3: Write minimal implementation**

```ts
// Both statements carry the SAME eligibility clause AND the same
// no-live-ballot clause, so they succeed together or not at all.
//
// ORDER MATTERS: the ballot insert runs FIRST. Reversed, the receipt upsert
// sets live_receipt_hash and the ballot's own NOT EXISTS guard then fails
// against the row it just wrote, refusing every first ballot.
//
// A voter holding a live ballot is refused by that guard rather than by the
// vote_receipt primary key. After a void the receipt row still exists and
// must be reusable, so a plain INSERT would 409 a legitimate recast. The
// guarantee is unchanged: one transaction, both statements conditional, so a
// second submission writes neither a ballot nor a receipt.
const ELIGIBLE = `
  EXISTS (
    SELECT 1
    FROM voter_roll vr
    JOIN check_in ci ON ci.batch_id = vr.batch_id AND ci.usu_id = vr.usu_id
    JOIN election e  ON e.id = ?2 AND e.batch_id = vr.batch_id AND e.status = 'open'
    WHERE vr.batch_id = ?1 AND vr.usu_id = ?3 AND vr.eligible = 1
  )`

const NO_LIVE_BALLOT = `
  NOT EXISTS (
    SELECT 1 FROM vote_receipt
    WHERE election_id = ?2 AND usu_id = ?3 AND live_receipt_hash IS NOT NULL
  )`

// One tuple, both statements: the numbered placeholders mean each statement
// uses the subset it needs and SQLite sizes the bind list by the highest index.
const params = [batchId, electionId, usuId, Date.now(), crypto.randomUUID(), JSON.stringify(preferences), receiptHash]

const ballotStmt = c.env.DB.prepare(
  `INSERT INTO ballot (id, election_id, preferences, receipt_hash, voided)
   SELECT ?5, ?2, ?6, ?7, 0 WHERE ${ELIGIBLE} AND ${NO_LIVE_BALLOT}`,
).bind(...params)

// The mark-off. DO UPDATE, not a bare INSERT: the row survives a void.
// recast_count is NOT touched here -- the void already counted the recast.
const receiptStmt = c.env.DB.prepare(
  `INSERT INTO vote_receipt (election_id, usu_id, voted_at, recast_count, live_receipt_hash)
   SELECT ?2, ?3, ?4, 0, ?7 WHERE ${ELIGIBLE}
   ON CONFLICT(election_id, usu_id) DO UPDATE
     SET voted_at = ?4, live_receipt_hash = ?7
     WHERE vote_receipt.live_receipt_hash IS NULL`,
).bind(...params)
```

**Migration `0002` adds `vote_receipt.live_receipt_hash`.** It is how the void in Task 7 knows
whose mark-off to clear: `ballot` has no voter reference, so a void keyed only on `receipt_hash`
has no other way to find the row. The cost, accepted deliberately by the user after being shown
it: while a ballot is live, the database holds a join from `usu_id` to that ballot's preferences —
the correlation spec §2 drops `cast_at` and ROWID to prevent. It is bounded, and must stay bounded:
the void NULLs it, **Plan 2c's close must NULL it for the whole election**, and the post-AGM purge
must cover `vote_receipt`. A partial UNIQUE index stops two receipt rows ever claiming one ballot.

Order of work in the handler:

1. `requireRole('voter')`, then `requireSession(c)` for the `usu_id`.
2. Load the election's candidate ids and `seats`. If the election is not `open`, 409.
3. `validateBallot(preferences, candidateIds, seats)` from `@election/core` — 400 with its `reason` on failure. The reason strings are written to be read by a voter mid-ballot.
4. Mint a receipt token with `crypto.randomUUID()`; store `receipt_hash = sha256(token)` via `crypto.subtle`. **The token is returned once and never stored.**
5. `DB.batch([ballotStmt, receiptStmt])` in one transaction — **ballot first**, per the comment
   above. Both statements report `changes === 1` or both report `0`; the guards are equivalent, so a
   1/0 split is unreachable and is treated as a bug rather than papered over. On `0`, read the
   receipt row once to answer: a row with `live_receipt_hash IS NOT NULL` → **409** already voted;
   anything else → **403** (not eligible, not checked in, or the election closed between steps 2 and 5).
6. Audit `ballot.cast` with **no detail**.
7. Return `201 { receipt_token }`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run -w @election/api test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/api
git commit -m "feat(api): transactional ballot submission with eligibility re-checked in the insert"
```

---

### Task 7: Receipts — verify inclusion, and void

**Files:**
- Create: `apps/api/src/routes/receipts.ts`
- Modify: `apps/api/src/index.ts`
- Test: `apps/api/tests/receipts.test.ts`

**Interfaces:**
- Consumes: nothing new
- Produces: `GET /api/receipts/:token`, `POST /api/receipts/:token/void`

**The receipt confirms inclusion and never displays preferences.** Australia has no voter receipt, deliberately: a receipt that proves *how* you voted lets you be paid or pressured for it, and society elections with factions are not immune. Confirming that a ballot of yours is recorded keeps the "my vote wasn't counted" dispute solvable while remaining useless to a coercer.

**Looking up by `receipt_hash` reveals nothing about identity** — the ballot row has no voter reference. That is what makes this endpoint safe to expose without a session.

- [ ] **Step 1: Write the failing test**

```ts
describe('receipts', () => {
  it('confirms a ballot is recorded', async () => {
    const token = await castAndGetToken()
    const res = await SELF.fetch(`https://example.com/api/receipts/${token}`)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ status: 'recorded', election_name: 'President' })
  })

  it('NEVER returns the preferences', async () => {
    const token = await castAndGetToken()
    const text = await (await SELF.fetch(`https://example.com/api/receipts/${token}`)).text()
    expect(text).not.toMatch(/preferences|"a"|"b"/)
  })

  it('404s an unknown token', async () => {
    expect((await SELF.fetch(`https://example.com/api/receipts/${crypto.randomUUID()}`)).status).toBe(404)
  })

  it('voids a ballot while the election is open', async () => {
    const token = await castAndGetToken()
    const res = await SELF.fetch(`https://example.com/api/receipts/${token}/void`, { method: 'POST' })
    expect(res.status).toBe(200)
    const row = await env.DB.prepare('SELECT voided FROM ballot').first<{ voided: number }>()
    expect(row!.voided).toBe(1)
  })

  it('keeps the voided ballot row, so the seal still covers it', async () => {
    const token = await castAndGetToken()
    await SELF.fetch(`https://example.com/api/receipts/${token}/void`, { method: 'POST' })
    const row = await env.DB.prepare('SELECT count(*) c FROM ballot').first<{ c: number }>()
    expect(row!.c).toBe(1)
  })

  it('lets the voter cast again after voiding', async () => {
    const token = await castAndGetToken()
    await SELF.fetch(`https://example.com/api/receipts/${token}/void`, { method: 'POST' })
    expect((await submit(['b', 'a'])).status).toBe(201)
    const row = await env.DB.prepare('SELECT recast_count FROM vote_receipt').first<{ recast_count: number }>()
    expect(row!.recast_count).toBe(1)
  })

  it('reports a voided ballot as voided', async () => {
    const token = await castAndGetToken()
    await SELF.fetch(`https://example.com/api/receipts/${token}/void`, { method: 'POST' })
    expect(await (await SELF.fetch(`https://example.com/api/receipts/${token}`)).json())
      .toMatchObject({ status: 'voided' })
  })

  it('refuses to void once the election is closed', async () => {
    const token = await castAndGetToken()
    await closeElection()
    expect((await SELF.fetch(`https://example.com/api/receipts/${token}/void`, { method: 'POST' })).status).toBe(409)
  })

  it('refuses to void the same ballot twice', async () => {
    const token = await castAndGetToken()
    await SELF.fetch(`https://example.com/api/receipts/${token}/void`, { method: 'POST' })
    expect((await SELF.fetch(`https://example.com/api/receipts/${token}/void`, { method: 'POST' })).status).toBe(409)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run -w @election/api test -- receipts`
Expected: FAIL — routes not registered

- [ ] **Step 3: Write minimal implementation**

- Hash the supplied token and look up `ballot` by `receipt_hash` (the `ballot_receipt` index exists for this).
- `GET` returns `{ status: 'recorded' | 'voided', election_name }`. **No preferences, ever.**
- `POST /void` — two conditional updates in one `DB.batch()`, so a closing election cannot be raced:

```sql
-- 1. the ballot. Stays in the table: the seal must still cover it.
UPDATE ballot SET voided = 1
 WHERE receipt_hash = ?1 AND voided = 0
   AND (SELECT status FROM election WHERE id = ballot.election_id) = 'open';

-- 2. the mark-off. live_receipt_hash IS the WHERE clause -- it is the only
--    thing that connects this token to a voter, because ballot carries no
--    voter reference. recast_count is incremented HERE (spec §4: "voiding
--    ... increments recast_count"), so the re-cast in Task 6 must not
--    increment it again.
UPDATE vote_receipt
   SET live_receipt_hash = NULL, recast_count = recast_count + 1, voted_at = ?2
 WHERE live_receipt_hash = ?1
   AND (SELECT status FROM election WHERE id = vote_receipt.election_id) = 'open';
```

  `changes === 0` on the ballot → 409. A second void of the same token finds `voided = 1` and a
  `live_receipt_hash` already NULL, so both statements match nothing — 409, idempotently refused.

  This must be an UPDATE, never a DELETE of the receipt: deleting would let the voter cast again
  *and* erase the mark-off, so the roll would stop showing that they had voted.

  Because the receipt row is found *through* the hash, a void always clears the true owner's flag.
  Someone holding a stolen token can therefore destroy that voter's ballot — which spec §5's public
  void endpoint already accepts — but cannot mint a second live ballot for themselves.
- Rate-limited with `RATE_LIMITS.voting`. Audit `ballot.void` with **no detail**.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run -w @election/api test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/api
git commit -m "feat(api): inclusion-only receipts with void and recast"
```

---

## Success criteria for Plan 2b

- `npm run -w @election/api test` passes with no skipped tests; `npm run -w @election/api typecheck` clean.
- `apps/api` still depends only on `hono`, `zod`, `@election/core`.
- A second ballot from the same voter is refused **by the database**, and leaves exactly one ballot row.
- A voter un-checked-in after signing in cannot cast, and no ballot row is written.
- `ballot` still has exactly `id, election_id, preferences, receipt_hash, voided` — no voter reference, no timestamp.
- No `audit_log.detail` anywhere contains a 7-digit id or a UUID.
- A receipt never returns preferences.
- `vote_receipt.live_receipt_hash` is NULL for every voided ballot, and no two receipt rows ever
  carry the same non-NULL value (enforced by a partial UNIQUE index, not by convention).
- Candidates cannot be added, renamed or removed once an election is open.
- An election with no candidates, or fewer candidates than seats, cannot be opened.

## What Plan 2b does NOT cover

Plan 2c owns: closing an election and writing `election_seal` — **and, in the same transaction,
`UPDATE vote_receipt SET live_receipt_hash = NULL` for that election, which is what keeps the
ballot↔voter join open only while ballots can still be voided; the post-AGM purge must also cover
`vote_receipt`, whose `usu_id` spec §2's retention paragraph does not currently name; counting via `@election/core`; the tie-break override (spec §5 names the field `winner_id`, but for `kind: 'exclusion'` the id is the candidate to **exclude** — rename it `resolved_id` or translate by `kind`); `election_result` versioning with `supersedes`; exports (attendance CSV, anonymous ballot CSV, sealed result) with `ORDER BY id` written **explicitly** rather than inherited from `WITHOUT ROWID` storage order; adding the `voided` column to the ballot export so the seal becomes reproducible from it (spec §2 currently documents that it is not); R2 logo upload with magic-byte validation; and the post-AGM roll purge.
