# apps/api Foundation Implementation Plan (Plan 2a)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up the Cloudflare Worker, the D1 schema, and the authentication that every later endpoint depends on — so a batch can be provisioned and an officer or door volunteer can sign in.

**Architecture:** Hono on Workers with a D1 binding. Hand-written SQL migrations (no ORM). PBKDF2 password hashing via WebCrypto. Signed `HttpOnly` cookies scoped to one batch and one role.

**Tech Stack:** Hono, Zod, `@election/core`, Vitest with `@cloudflare/vitest-pool-workers`, wrangler.

**Spec:** `docs/superpowers/specs/2026-09-16-election-code-rewrite-design.md`
**Handoff / current state:** `docs/superpowers/HANDOFF.md` — read §6 before starting.
**Plan 2a of 3.** Plan 2b adds roll import, check-in, elections, ballots, results and exports. Plan 3 is the two frontends.

## Global Constraints

- **No ORM.** `wrangler d1 migrations` for versioning, D1's prepared-statement API for queries, hand-written row types. Justification is in spec §1.
- **`ballot` MUST be created `WITHOUT ROWID` with a random UUID primary key and no timestamp column.** This is the entire basis of the secret-ballot guarantee (spec §2). A test asserts the clause is present.
- Runtime dependencies limited to `hono` and `zod`, plus the workspace-internal `@election/core`. Anything else needs justification in the commit message.
- TypeScript `strict: true`, `noUncheckedIndexedAccess: true`, `noUnusedLocals: true`. No `any` in exported signatures.
- **Password hashing is PBKDF2-HMAC-SHA256 via WebCrypto**, 210,000 iterations, 16-byte random salt. Argon2 and bcrypt need WASM on Workers and are not used.
- **Comparisons of secrets are constant-time.**
- Ids are `crypto.randomUUID()`. No uuid package.
- Every privileged action writes an `audit_log` row.
- TDD throughout: failing test, watch it fail, implement, commit.

---

### Task 1: Worker scaffold and health endpoint

**Files:**
- Create: `apps/api/package.json`, `apps/api/tsconfig.json`, `apps/api/wrangler.jsonc`, `apps/api/vitest.config.ts`
- Create: `apps/api/src/index.ts`
- Test: `apps/api/tests/health.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: a Hono `app` default-exported from `src/index.ts`; `npm run -w @election/api test` runs against a real Worker runtime

- [ ] **Step 1: Write the failing test**

`apps/api/tests/health.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { SELF } from 'cloudflare:test'

describe('health', () => {
  it('reports ok', async () => {
    const res = await SELF.fetch('https://example.com/api/health')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ status: 'ok' })
  })

  it('404s an unknown route as JSON, not HTML', async () => {
    const res = await SELF.fetch('https://example.com/api/nope')
    expect(res.status).toBe(404)
    expect(res.headers.get('content-type')).toMatch(/application\/json/)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm install && npm run -w @election/api test`
Expected: FAIL — no such workspace / cannot resolve `src/index.ts`

- [ ] **Step 3: Write minimal implementation**

`apps/api/package.json`:

```json
{
  "name": "@election/api",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "vitest run",
    "typecheck": "tsc --noEmit",
    "dev": "wrangler dev",
    "deploy": "wrangler deploy"
  },
  "dependencies": {
    "hono": "^4.6.0",
    "zod": "^3.23.0",
    "@election/core": "*"
  }
}
```

Add `@cloudflare/vitest-pool-workers` and `wrangler` to the ROOT `package.json` devDependencies.

`apps/api/wrangler.jsonc`:

```jsonc
{
  "name": "election-api",
  "main": "src/index.ts",
  "compatibility_date": "2026-09-01",
  "compatibility_flags": ["nodejs_compat"],
  "d1_databases": [
    { "binding": "DB", "database_name": "election", "database_id": "PLACEHOLDER_SET_BY_WRANGLER" }
  ],
  "observability": { "enabled": true }
}
```

`apps/api/vitest.config.ts`:

```ts
import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config'

export default defineWorkersConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    poolOptions: {
      workers: {
        wrangler: { configPath: './wrangler.jsonc' },
        miniflare: { d1Databases: ['DB'] },
      },
    },
  },
})
```

`apps/api/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "types": ["@cloudflare/vitest-pool-workers"] },
  "include": ["src", "tests"]
}
```

`apps/api/src/index.ts`:

```ts
import { Hono } from 'hono'

export type Env = {
  DB: D1Database
  SUPER_ADMIN_KEY: string
  SESSION_SECRET: string
}

const app = new Hono<{ Bindings: Env }>()

app.get('/api/health', (c) => c.json({ status: 'ok' }))

app.notFound((c) => c.json({ error: 'not found' }, 404))

export default app
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run -w @election/api test`
Expected: PASS, 2 tests

- [ ] **Step 5: Commit**

```bash
git add apps/api package.json package-lock.json
git commit -m "feat(api): Worker scaffold with health endpoint"
```

---

### Task 2: D1 schema migration

**Files:**
- Create: `apps/api/migrations/0001_initial.sql`
- Create: `apps/api/src/db/types.ts`
- Test: `apps/api/tests/schema.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: the full schema from spec §2; row types `BatchRow`, `VoterRollRow`, `CheckInRow`, `ElectionRow`, `CandidateRow`, `BallotRow`, `VoteReceiptRow`, `ElectionSealRow`, `ElectionResultRow`, `AuditLogRow`

- [ ] **Step 1: Write the failing test**

`apps/api/tests/schema.test.ts`:

```ts
import { describe, it, expect, beforeAll } from 'vitest'
import { env, applyD1Migrations } from 'cloudflare:test'

beforeAll(async () => {
  await applyD1Migrations(env.DB, await import('../migrations/0001_initial.sql?raw').then(m => m.default) as never)
})

const sqlFor = async (table: string): Promise<string> => {
  const row = await env.DB
    .prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name=?`)
    .bind(table)
    .first<{ sql: string }>()
  return row?.sql ?? ''
}

describe('schema', () => {
  it('creates every table the spec defines', async () => {
    for (const t of [
      'batch', 'voter_roll', 'check_in', 'election', 'candidate',
      'ballot', 'vote_receipt', 'election_seal', 'election_result', 'audit_log',
    ]) {
      expect(await sqlFor(t), `missing table: ${t}`).not.toBe('')
    }
  })

  it('creates ballot WITHOUT ROWID', async () => {
    // This clause is the entire basis of the secret-ballot guarantee: it makes
    // physical row order follow the random UUID key rather than insertion order.
    // Losing it silently reintroduces the ballot/roll correlation leak.
    expect(await sqlFor('ballot')).toMatch(/WITHOUT\s+ROWID/i)
  })

  it('gives ballot no timestamp column', async () => {
    const cols = await env.DB.prepare(`PRAGMA table_info(ballot)`).all<{ name: string }>()
    const names = cols.results.map((r) => r.name)
    expect(names).not.toContain('cast_at')
    expect(names).not.toContain('created_at')
    expect(names.sort()).toEqual(['election_id', 'id', 'preferences', 'receipt_hash', 'voided'])
  })

  it('makes (election_id, usu_id) the double-vote guard on vote_receipt', async () => {
    await env.DB.prepare(
      `INSERT INTO batch (id,slug,name,officer_hash,door_hash,branding,created_at)
       VALUES ('b1','s','n','x','y','{}',1)`).run()
    await env.DB.prepare(
      `INSERT INTO election (id,batch_id,name,seats,status) VALUES ('e1','b1','E',1,'open')`).run()
    await env.DB.prepare(
      `INSERT INTO vote_receipt (election_id,usu_id,voted_at) VALUES ('e1','2400001',1)`).run()

    await expect(
      env.DB.prepare(`INSERT INTO vote_receipt (election_id,usu_id,voted_at) VALUES ('e1','2400001',2)`).run(),
    ).rejects.toThrow(/UNIQUE|constraint/i)
  })

  it('rejects an election with seats below 1', async () => {
    await expect(
      env.DB.prepare(
        `INSERT INTO election (id,batch_id,name,seats,status) VALUES ('e2','b1','E',0,'draft')`).run(),
    ).rejects.toThrow(/CHECK|constraint/i)
  })

  it('rejects an unknown election status', async () => {
    await expect(
      env.DB.prepare(
        `INSERT INTO election (id,batch_id,name,seats,status) VALUES ('e3','b1','E',1,'counting')`).run(),
    ).rejects.toThrow(/CHECK|constraint/i)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run -w @election/api test -- schema`
Expected: FAIL — migration file does not exist

- [ ] **Step 3: Write minimal implementation**

`apps/api/migrations/0001_initial.sql` — copy the schema from spec §2 verbatim, with these exact requirements:
- `ballot` declared `WITHOUT ROWID`, `id TEXT PRIMARY KEY`, columns exactly `id, election_id, preferences, receipt_hash, voided`, and **no timestamp column**
- `CREATE INDEX ballot_receipt ON ballot(receipt_hash)`
- `vote_receipt` primary key `(election_id, usu_id)`
- `election.seats` with `CHECK (seats >= 1)`, `election.status` with `CHECK (status IN ('draft','open','closed'))`
- `voter_roll` primary key `(batch_id, usu_id)`, columns `batch_id, usu_id, first_name, last_name, eligible` only — **no email, no member_id, no user_id**
- `election_seal` separate from `election_result`; `election_result` has `supersedes INTEGER REFERENCES election_result(id)`
- Foreign keys with `ON DELETE CASCADE` as the spec shows

`apps/api/src/db/types.ts` — one exported type per table, field names and SQLite types matching the migration exactly. Integers for booleans and timestamps.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run -w @election/api test -- schema`
Expected: PASS, 6 tests

- [ ] **Step 5: Commit**

```bash
git add apps/api/migrations apps/api/src/db apps/api/tests/schema.test.ts
git commit -m "feat(api): D1 schema with WITHOUT ROWID ballots and the double-vote constraint"
```

---

### Task 3: Password hashing

**Files:**
- Create: `apps/api/src/auth/password.ts`
- Test: `apps/api/tests/password.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: `hashPassword(plain: string): Promise<string>`, `verifyPassword(plain: string, stored: string): Promise<boolean>`

- [ ] **Step 1: Write the failing test**

`apps/api/tests/password.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { hashPassword, verifyPassword } from '../src/auth/password.js'

describe('password hashing', () => {
  it('round-trips a correct password', async () => {
    const stored = await hashPassword('correct horse battery staple')
    expect(await verifyPassword('correct horse battery staple', stored)).toBe(true)
  })

  it('rejects a wrong password', async () => {
    const stored = await hashPassword('correct horse')
    expect(await verifyPassword('wrong horse', stored)).toBe(false)
  })

  it('salts, so the same password hashes differently every time', async () => {
    expect(await hashPassword('same')).not.toBe(await hashPassword('same'))
  })

  it('stores algorithm, iterations and salt in the encoded form', async () => {
    const stored = await hashPassword('x')
    const [scheme, iterations] = stored.split('$')
    expect(scheme).toBe('pbkdf2-sha256')
    expect(Number(iterations)).toBeGreaterThanOrEqual(210_000)
    expect(stored.split('$')).toHaveLength(4)
  })

  it('never stores the plaintext', async () => {
    expect(await hashPassword('hunter2')).not.toContain('hunter2')
  })

  it('returns false rather than throwing on a malformed stored value', async () => {
    expect(await verifyPassword('x', 'garbage')).toBe(false)
    expect(await verifyPassword('x', '')).toBe(false)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run -w @election/api test -- password`
Expected: FAIL — cannot resolve `../src/auth/password.js`

- [ ] **Step 3: Write minimal implementation**

`apps/api/src/auth/password.ts`:

```ts
/**
 * PBKDF2-HMAC-SHA256 via WebCrypto.
 *
 * Argon2 and bcrypt are deliberately not used: both need a WASM build on
 * Workers, where PBKDF2 is native. 210,000 iterations follows OWASP guidance
 * for PBKDF2-HMAC-SHA256.
 *
 * Encoded form: pbkdf2-sha256$<iterations>$<salt-b64>$<hash-b64>
 */
const SCHEME = 'pbkdf2-sha256'
const ITERATIONS = 210_000
const SALT_BYTES = 16
const KEY_BITS = 256

const b64 = (b: ArrayBuffer): string => btoa(String.fromCharCode(...new Uint8Array(b)))
const unb64 = (s: string): Uint8Array =>
  Uint8Array.from(atob(s), (ch) => ch.charCodeAt(0))

async function derive(plain: string, salt: Uint8Array, iterations: number): Promise<ArrayBuffer> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(plain), 'PBKDF2', false, ['deriveBits'])
  return crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations, hash: 'SHA-256' }, key, KEY_BITS)
}

export async function hashPassword(plain: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES))
  const bits = await derive(plain, salt, ITERATIONS)
  return `${SCHEME}$${ITERATIONS}$${b64(salt.buffer)}$${b64(bits)}`
}

/** Constant-time comparison. Never short-circuit on the first differing byte. */
function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!
  return diff === 0
}

export async function verifyPassword(plain: string, stored: string): Promise<boolean> {
  const parts = stored.split('$')
  if (parts.length !== 4) return false
  const [scheme, iterStr, saltB64, hashB64] = parts as [string, string, string, string]
  if (scheme !== SCHEME) return false
  const iterations = Number(iterStr)
  if (!Number.isInteger(iterations) || iterations < 1) return false
  try {
    const bits = await derive(plain, unb64(saltB64), iterations)
    return timingSafeEqual(new Uint8Array(bits), unb64(hashB64))
  } catch {
    return false
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run -w @election/api test -- password`
Expected: PASS, 6 tests

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/auth/password.ts apps/api/tests/password.test.ts
git commit -m "feat(api): PBKDF2 password hashing with constant-time comparison"
```

---

### Task 4: Signed session cookies

**Files:**
- Create: `apps/api/src/auth/session.ts`
- Test: `apps/api/tests/session.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: `type Role = 'officer' | 'door' | 'voter'`, `type Session = { batchId: string; role: Role; subject?: string; exp: number }`, `signSession(s: Session, secret: string): Promise<string>`, `verifySession(token: string, secret: string, now?: number): Promise<Session | null>`, `cookieName(batchId: string, role: Role): string`, `cookieOptions(maxAgeSeconds: number)`

- [ ] **Step 1: Write the failing test**

`apps/api/tests/session.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { signSession, verifySession, cookieName, cookieOptions, type Session } from '../src/auth/session.js'

const SECRET = 'test-secret-value'
const base = (over: Partial<Session> = {}): Session => ({
  batchId: 'b1', role: 'officer', exp: 9_999_999_999, ...over,
})

describe('session tokens', () => {
  it('round-trips a session', async () => {
    const t = await signSession(base(), SECRET)
    expect(await verifySession(t, SECRET)).toEqual(base())
  })

  it('rejects a token signed with a different secret', async () => {
    const t = await signSession(base(), SECRET)
    expect(await verifySession(t, 'other-secret')).toBeNull()
  })

  it('rejects a tampered payload', async () => {
    const t = await signSession(base(), SECRET)
    const [payload, sig] = t.split('.') as [string, string]
    const forged = btoa(JSON.stringify(base({ role: 'officer', batchId: 'b2' })))
      .replace(/=/g, '')
    expect(await verifySession(`${forged}.${sig}`, SECRET)).toBeNull()
    expect(payload).toBeTruthy()
  })

  it('rejects an expired token', async () => {
    const t = await signSession(base({ exp: 1_000 }), SECRET)
    expect(await verifySession(t, SECRET, 2_000)).toBeNull()
  })

  it('rejects garbage', async () => {
    for (const bad of ['', 'x', 'a.b.c', '.', 'notbase64.sig']) {
      expect(await verifySession(bad, SECRET)).toBeNull()
    }
  })

  it('scopes the cookie name to batch and role, so one does not authorise the other', async () => {
    expect(cookieName('b1', 'officer')).not.toBe(cookieName('b1', 'door'))
    expect(cookieName('b1', 'officer')).not.toBe(cookieName('b2', 'officer'))
  })

  it('sets HttpOnly, Secure, SameSite=Strict and a max age', () => {
    const o = cookieOptions(3600)
    expect(o.httpOnly).toBe(true)
    expect(o.secure).toBe(true)
    expect(o.sameSite).toBe('Strict')
    expect(o.maxAge).toBe(3600)
    expect(o.path).toBe('/')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run -w @election/api test -- session`
Expected: FAIL — cannot resolve `../src/auth/session.js`

- [ ] **Step 3: Write minimal implementation**

`apps/api/src/auth/session.ts`:

```ts
/**
 * Signed session tokens carried in an HttpOnly cookie.
 *
 * The password itself is never sent again after sign-in and never reaches
 * JavaScript, so an XSS cannot exfiltrate it. The cookie name is scoped to
 * one batch and one role, so a door volunteer's cookie cannot authorise an
 * officer route even on the same browser.
 */
export type Role = 'officer' | 'door' | 'voter'

export type Session = {
  batchId: string
  role: Role
  /** usu_id for a voter session; absent for officer/door */
  subject?: string
  /** unix seconds */
  exp: number
}

const enc = new TextEncoder()

const b64url = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

const unb64url = (s: string): Uint8Array => {
  const pad = s.replace(/-/g, '+').replace(/_/g, '/')
  return Uint8Array.from(atob(pad + '='.repeat((4 - (pad.length % 4)) % 4)), (c) => c.charCodeAt(0))
}

async function hmac(data: string, secret: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(data)))
}

function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!
  return diff === 0
}

export async function signSession(session: Session, secret: string): Promise<string> {
  const payload = b64url(enc.encode(JSON.stringify(session)))
  return `${payload}.${b64url(await hmac(payload, secret))}`
}

export async function verifySession(
  token: string,
  secret: string,
  now: number = Math.floor(Date.now() / 1000),
): Promise<Session | null> {
  const parts = token.split('.')
  if (parts.length !== 2) return null
  const [payload, sig] = parts as [string, string]
  if (!payload || !sig) return null
  try {
    if (!timingSafeEqual(await hmac(payload, secret), unb64url(sig))) return null
    const session = JSON.parse(new TextDecoder().decode(unb64url(payload))) as Session
    if (typeof session.exp !== 'number' || session.exp <= now) return null
    if (session.role !== 'officer' && session.role !== 'door' && session.role !== 'voter') return null
    if (typeof session.batchId !== 'string' || session.batchId === '') return null
    return session
  } catch {
    return null
  }
}

export const cookieName = (batchId: string, role: Role): string => `es_${role}_${batchId}`

export const cookieOptions = (maxAgeSeconds: number) =>
  ({ httpOnly: true, secure: true, sameSite: 'Strict', path: '/', maxAge: maxAgeSeconds }) as const
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run -w @election/api test -- session`
Expected: PASS, 7 tests

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/auth/session.ts apps/api/tests/session.test.ts
git commit -m "feat(api): signed, role-scoped session cookies"
```

---

### Task 5: Audit log and batch provisioning

**Files:**
- Create: `apps/api/src/db/audit.ts`, `apps/api/src/routes/batches.ts`
- Modify: `apps/api/src/index.ts`
- Test: `apps/api/tests/batches.test.ts`

**Interfaces:**
- Consumes: `hashPassword`, `Env`, row types
- Produces: `recordAudit(db, entry)`; `POST /api/batches`, `GET /api/batches`, `GET /api/batches/by-slug/:slug`

- [ ] **Step 1: Write the failing test**

`apps/api/tests/batches.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest'
import { SELF, env, applyD1Migrations } from 'cloudflare:test'

const KEY = 'super-secret-test-key'

beforeEach(async () => {
  await applyD1Migrations(env.DB, await import('../migrations/0001_initial.sql?raw').then(m => m.default) as never)
  await env.DB.prepare('DELETE FROM audit_log').run()
  await env.DB.prepare('DELETE FROM batch').run()
})

const create = (body: unknown, key?: string) =>
  SELF.fetch('https://example.com/api/batches', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(key ? { 'x-super-admin-key': key } : {}) },
    body: JSON.stringify(body),
  })

const valid = {
  name: 'SciSoc AGM 2026', slug: 'scisoc-2026',
  officer_password: 'officer-pw', door_password: 'door-pw',
  branding: { title: 'Executive Elections', org_name: 'SciSoc', accent_color: '#2563eb', logo_url: '' },
}

describe('POST /api/batches', () => {
  it('refuses without the super admin key', async () => {
    expect((await create(valid)).status).toBe(401)
  })

  it('refuses a wrong super admin key', async () => {
    expect((await create(valid, 'wrong')).status).toBe(401)
  })

  it('creates a batch with the key', async () => {
    const res = await create(valid, KEY)
    expect(res.status).toBe(201)
    const body = await res.json() as { id: string; slug: string }
    expect(body.slug).toBe('scisoc-2026')
    expect(body.id).toMatch(/^[0-9a-f-]{36}$/)
  })

  it('never returns a password or a hash', async () => {
    const text = await (await create(valid, KEY)).text()
    expect(text).not.toContain('officer-pw')
    expect(text).not.toContain('door-pw')
    expect(text).not.toContain('pbkdf2')
  })

  it('stores hashes, not plaintext', async () => {
    await create(valid, KEY)
    const row = await env.DB.prepare('SELECT officer_hash, door_hash FROM batch').first<{ officer_hash: string; door_hash: string }>()
    expect(row!.officer_hash).toMatch(/^pbkdf2-sha256\$/)
    expect(row!.door_hash).toMatch(/^pbkdf2-sha256\$/)
    expect(row!.officer_hash).not.toBe(row!.door_hash)
  })

  it('rejects a duplicate slug', async () => {
    await create(valid, KEY)
    expect((await create(valid, KEY)).status).toBe(409)
  })

  it('rejects a missing field with 400', async () => {
    expect((await create({ name: 'x' }, KEY)).status).toBe(400)
  })

  it('writes an audit_log row', async () => {
    await create(valid, KEY)
    const row = await env.DB.prepare(`SELECT role, action FROM audit_log`).first<{ role: string; action: string }>()
    expect(row).toEqual({ role: 'super', action: 'batch.create' })
  })
})

describe('public batch listing', () => {
  it('returns slug and branding only — never a hash', async () => {
    await create(valid, KEY)
    const res = await SELF.fetch('https://example.com/api/batches')
    expect(res.status).toBe(200)
    const list = await res.json() as Array<Record<string, unknown>>
    expect(list).toHaveLength(1)
    expect(Object.keys(list[0]!).sort()).toEqual(['branding', 'name', 'slug'])
  })

  it('looks a batch up by slug', async () => {
    await create(valid, KEY)
    const res = await SELF.fetch('https://example.com/api/batches/by-slug/scisoc-2026')
    expect(res.status).toBe(200)
    const b = await res.json() as Record<string, unknown>
    expect(Object.keys(b).sort()).toEqual(['branding', 'id', 'name', 'slug'])
  })

  it('404s an unknown slug', async () => {
    expect((await SELF.fetch('https://example.com/api/batches/by-slug/nope')).status).toBe(404)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run -w @election/api test -- batches`
Expected: FAIL — route not registered, 404 where 201 expected

- [ ] **Step 3: Write minimal implementation**

`apps/api/src/db/audit.ts`:

```ts
export type AuditEntry = {
  batchId: string
  role: 'super' | 'officer' | 'door'
  action: string
  detail?: unknown
}

/** Every privileged action leaves a row. Spec §6. */
export async function recordAudit(db: D1Database, entry: AuditEntry): Promise<void> {
  await db
    .prepare(`INSERT INTO audit_log (batch_id, role, action, detail, at) VALUES (?,?,?,?,?)`)
    .bind(entry.batchId, entry.role, entry.action, entry.detail === undefined ? null : JSON.stringify(entry.detail), Date.now())
    .run()
}
```

`apps/api/src/routes/batches.ts` — a Hono router that:
- `POST /api/batches`: reads `x-super-admin-key`, compares against `c.env.SUPER_ADMIN_KEY` in constant time (reuse the comparison approach from `password.ts`; extract a shared helper if you prefer, but do not weaken it to `===`), returns 401 on mismatch **before** touching the body. Validates the body with Zod: `name`, `slug`, `officer_password`, `door_password`, `branding {title, org_name, accent_color, logo_url}`. Hashes both passwords, inserts with `crypto.randomUUID()`, returns 201 with `{id, slug, name, branding}` — never a hash. A slug collision returns 409. Writes `audit_log` with `role: 'super'`, `action: 'batch.create'`.
- `GET /api/batches`: returns `[{slug, name, branding}]` only.
- `GET /api/batches/by-slug/:slug`: returns `{id, slug, name, branding}` or 404.

Mount it in `src/index.ts` with `app.route('/', batches)`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run -w @election/api test`
Expected: PASS, all tests

- [ ] **Step 5: Commit**

```bash
git add apps/api/src apps/api/tests/batches.test.ts
git commit -m "feat(api): batch provisioning behind the super admin key, with audit log"
```

---

### Task 6: Officer and door sign-in

**Files:**
- Create: `apps/api/src/routes/auth.ts`, `apps/api/src/middleware/requireRole.ts`
- Modify: `apps/api/src/index.ts`
- Test: `apps/api/tests/auth.test.ts`

**Interfaces:**
- Consumes: `verifyPassword`, `signSession`, `verifySession`, `cookieName`, `cookieOptions`, `recordAudit`
- Produces: `POST /api/batches/:id/officer/session`, `POST /api/batches/:id/door/session`, `requireRole(role)` middleware setting `c.get('session')`

- [ ] **Step 1: Write the failing test**

`apps/api/tests/auth.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest'
import { SELF, env, applyD1Migrations } from 'cloudflare:test'

const KEY = 'super-secret-test-key'
let batchId = ''

beforeEach(async () => {
  await applyD1Migrations(env.DB, await import('../migrations/0001_initial.sql?raw').then(m => m.default) as never)
  await env.DB.prepare('DELETE FROM audit_log').run()
  await env.DB.prepare('DELETE FROM batch').run()
  const res = await SELF.fetch('https://example.com/api/batches', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-super-admin-key': KEY },
    body: JSON.stringify({
      name: 'N', slug: 's', officer_password: 'officer-pw', door_password: 'door-pw',
      branding: { title: 't', org_name: 'o', accent_color: '#000000', logo_url: '' },
    }),
  })
  batchId = (await res.json() as { id: string }).id
})

const signIn = (role: 'officer' | 'door', password: string) =>
  SELF.fetch(`https://example.com/api/batches/${batchId}/${role}/session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password }),
  })

describe('sign-in', () => {
  it('accepts the officer password and sets an HttpOnly cookie', async () => {
    const res = await signIn('officer', 'officer-pw')
    expect(res.status).toBe(200)
    const cookie = res.headers.get('set-cookie') ?? ''
    expect(cookie).toMatch(/HttpOnly/i)
    expect(cookie).toMatch(/Secure/i)
    expect(cookie).toMatch(/SameSite=Strict/i)
  })

  it('accepts the door password', async () => {
    expect((await signIn('door', 'door-pw')).status).toBe(200)
  })

  it('rejects a wrong password', async () => {
    expect((await signIn('officer', 'nope')).status).toBe(401)
  })

  it('does NOT accept the door password on the officer route', async () => {
    // the whole point of two passwords: a door volunteer cannot become an officer
    expect((await signIn('officer', 'door-pw')).status).toBe(401)
  })

  it('does NOT accept the officer password on the door route', async () => {
    expect((await signIn('door', 'officer-pw')).status).toBe(401)
  })

  it('never echoes the password', async () => {
    expect(await (await signIn('officer', 'officer-pw')).text()).not.toContain('officer-pw')
  })

  it('404s an unknown batch without revealing whether it exists', async () => {
    const res = await SELF.fetch(`https://example.com/api/batches/${crypto.randomUUID()}/officer/session`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'x' }),
    })
    expect([401, 404]).toContain(res.status)
  })

  it('writes an audit row on success and on failure', async () => {
    await signIn('officer', 'officer-pw')
    await signIn('officer', 'wrong')
    const rows = await env.DB.prepare(`SELECT action FROM audit_log WHERE action LIKE 'session%'`).all<{ action: string }>()
    expect(rows.results.map(r => r.action).sort()).toEqual(['session.officer.fail', 'session.officer.ok'])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run -w @election/api test -- auth`
Expected: FAIL — routes not registered

- [ ] **Step 3: Write minimal implementation**

`apps/api/src/routes/auth.ts` — for each of `officer` and `door`:
- Load the batch by id. If absent, return 401 (do **not** distinguish "no such batch" from "wrong password" — it leaks which batches exist).
- Verify the supplied password against `officer_hash` or `door_hash` **only** — never both.
- On success: sign a `Session` with the matching role and an expiry (1 hour for `door`, 8 hours for `officer` — an AGM runs long and re-authenticating mid-count is worse than a longer session on a laptop the officer controls), set the cookie via `cookieName`/`cookieOptions`, return `{ ok: true, role }`.
- Write `audit_log` `session.<role>.ok` / `session.<role>.fail` either way.

`apps/api/src/middleware/requireRole.ts` — reads `cookieName(batchId, role)` from the request, calls `verifySession`, checks `session.batchId` matches the route's batch id, and sets `c.set('session', session)`. Returns 403 otherwise. **A door session must never satisfy `requireRole('officer')`.**

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run -w @election/api test`
Expected: PASS, all tests

- [ ] **Step 5: Commit**

```bash
git add apps/api/src apps/api/tests/auth.test.ts
git commit -m "feat(api): officer and door sign-in with role-scoped sessions"
```

---

## Success criteria for Plan 2a

- `npm run -w @election/api test` passes with no skipped tests.
- `npm run -w @election/api typecheck` is clean.
- The `ballot` table is created `WITHOUT ROWID`, has no timestamp column, and a test asserts both.
- A second insert into `vote_receipt` for the same `(election_id, usu_id)` is rejected by the database.
- A door password cannot obtain an officer session, and a door cookie cannot satisfy `requireRole('officer')`.
- No response body, log line or error message ever contains a password or a hash.
- `apps/api` depends only on `hono`, `zod` and `@election/core`.

## What Plan 2a does NOT cover

Plan 2b owns: roll import (`parseUsuExport` wiring, the diff preview, commit), door check-in and quorum, election lifecycle with the candidate freeze and irreversible close, voter sign-in by USU id + surname, ballot submission in a D1 transaction, receipts and voiding, sealing and counting via `@election/core`, tie-break overrides, exports, R2 logos, KV rate limiting, and the post-AGM roll purge.

## Carried-forward constraints

See `docs/superpowers/HANDOFF.md` §6 — eight constraints from Plan 1, including the `winner_id`/exclusion naming trap and the `voided`-column gap in the ballot export.
