# election-code rewrite — design

**Date:** 2026-09-16
**Status:** approved, ready for implementation planning

## Purpose

Rebuild the Dalyell society election system on a stack that does not lose
ballots, and make it emulate the Australian electoral system faithfully
enough to survive a disputed result.

The current system stores every election in a Python dictionary in process
memory. Render's free tier spins down after roughly fifteen minutes idle, so
a quiet stretch during an AGM destroys the election. That is the problem
this rewrite exists to solve. Everything else follows from taking the
"emulate the Australian system" goal seriously.

## Non-goals

- Migrating existing data. There is none; it lives in memory and is already
  gone. Only `backend/uploads/BGS_logo_horizontal2.jpg` carries over.
- Self-serve tenant signup. Batches are provisioned by the operator.
- Email, SMS or any outbound messaging.
- Remote or postal voting. Voters are physically present and checked in.

---

## 1. Architecture

A pnpm workspace with four packages, deployed to Cloudflare.

| Package | Contents | Deploys to |
| --- | --- | --- |
| `packages/core` | STV count, ballot validation, CSV import, Zod schemas and shared types. Pure TypeScript, zero runtime dependencies. | nothing — imported |
| `apps/api` | Hono on Workers. Bindings: D1, R2, KV. | `api.dalyell.com.au` |
| `apps/voter` | Preact (via React alias) + Vite 7 + TypeScript | `vote.dalyell.com.au` |
| `apps/admin` | React 19 + Vite 7 + TypeScript | `admin.dalyell.com.au` |

`packages/core` is dependency-free on purpose. The counting code is the part
that must be right, so it has to be testable in isolation and runnable
offline — a disputed count can be re-run on a laptop against an exported
ballot file, in front of whoever is disputing it.

Admin and voter stay separately deployed so the admin bundle is never served
to a voter's browser. Three deploys, the same number as today.

**Libraries**, each justified rather than assumed:

- **Hono** — routing on Workers. The alternative is hand-rolled URL matching,
  which is worse at this size.
- **Zod** — validation at every boundary. Hand-rolling ballot and CSV
  validation is exactly where quiet correctness bugs live.
- **Vitest** with `@cloudflare/vitest-pool-workers` — integration tests
  against real D1 rather than a mock.

**No ORM.** Drizzle was considered and rejected. `wrangler d1 migrations`
already versions schema natively, the schema is nine tables with simple
queries, and Drizzle's SQLite builder cannot emit `WITHOUT ROWID` — the one
clause the entire secret-ballot guarantee rests on. Migrations are hand-written
SQL against D1's prepared-statement API, with hand-written row types. Ids use
`crypto.randomUUID()`, which Workers provides; no uuid package.

**Sessions replace the password header.** Today `X-Admin-Token` carries the
actual password on every request and lives in `localStorage`, readable by any
XSS. Instead: sign in once, receive a signed `HttpOnly` `Secure`
`SameSite=Strict` cookie scoped to one batch and one role, with a short TTL.

> **Hard deployment precondition — the auth design fails silently without it.**
> `SameSite` is judged by registrable domain (eTLD+1), not by subdomain. All three
> deployments must therefore sit on custom subdomains of **one shared apex**:
> `api.dalyell.com.au`, `vote.dalyell.com.au`, `admin.dalyell.com.au`. If any of
> them is left on a platform default — `*.workers.dev`, `*.pages.dev`, `*.vercel.app`,
> `*.onrender.com` — the API and the frontend are different registrable domains, the
> browser never sends the cookie, and **every authenticated request fails with no
> error that points at the cause**.
>
> This also means authentication does not work on preview or `*.workers.dev` URLs.
> Test auth against the real hostnames, or against `localhost` where all three share
> an origin.
>
> The API must additionally send `Access-Control-Allow-Credentials: true` with an
> explicit allow-listed origin — never `*`, which browsers reject in combination with
> credentials — and the frontends must fetch with `credentials: 'include'`.

**Live counts use polling, not WebSockets.** The double-vote race is settled
by a database constraint, so a Durable Object buys nothing here. A room of a
few hundred people polling every three seconds is negligible.

---

## 2. Data model

### The correlation trap

The obvious schema — an autoincrementing ballot id alongside a timestamped
receipt — rebuilds exactly the flaw the current code has, where ballot *n*
belongs to the *n*th person to sign in. Three decisions prevent it:

1. `ballot` is `WITHOUT ROWID` with a random UUID primary key, so physical
   row order is UUID order, not insertion order.
2. Ballots carry **no timestamp**. A `cast_at` on the ballot plus a
   `voted_at` on the receipt is a join key in all but name.
3. Because of (2), post-close ballot stuffing is detected by the **seal** —
   count and hash frozen at close — not by per-ballot timestamps. That is
   what the seal is for.

### Schema

```sql
CREATE TABLE batch (
  id           TEXT PRIMARY KEY,
  slug         TEXT NOT NULL UNIQUE,
  name         TEXT NOT NULL,
  officer_hash TEXT NOT NULL,        -- pbkdf2$iters$salt$hash
  door_hash    TEXT NOT NULL,
  branding     TEXT NOT NULL,        -- JSON, Zod-validated on write
  created_at   INTEGER NOT NULL
);

CREATE TABLE voter_roll (
  batch_id   TEXT NOT NULL REFERENCES batch(id) ON DELETE CASCADE,
  -- usu_id is the "Net Id" column in the USU member export (7 digits).
  -- It is the only identifier a voter ever sees or types. The export's
  -- "User Identifier" (6) and "Member Identifier" (8) are not imported.
  usu_id     TEXT NOT NULL,
  first_name TEXT NOT NULL,
  last_name  TEXT NOT NULL,
  eligible   INTEGER NOT NULL DEFAULT 1,   -- computed at import: "Left Group" = 0
  PRIMARY KEY (batch_id, usu_id)
);

CREATE TABLE check_in (
  batch_id      TEXT NOT NULL,
  usu_id        TEXT NOT NULL,
  checked_in_at INTEGER NOT NULL,
  PRIMARY KEY (batch_id, usu_id),
  FOREIGN KEY (batch_id, usu_id)
    REFERENCES voter_roll(batch_id, usu_id) ON DELETE CASCADE
);

CREATE TABLE election (
  id        TEXT PRIMARY KEY,
  batch_id  TEXT NOT NULL REFERENCES batch(id) ON DELETE CASCADE,
  name      TEXT NOT NULL,
  seats     INTEGER NOT NULL DEFAULT 1 CHECK (seats >= 1),
  status    TEXT NOT NULL DEFAULT 'draft'
            CHECK (status IN ('draft','open','closed')),
  opened_at INTEGER,
  closed_at INTEGER
);

CREATE TABLE candidate (
  id          TEXT PRIMARY KEY,
  election_id TEXT NOT NULL REFERENCES election(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  ordinal     INTEGER NOT NULL
);

-- the secret part
CREATE TABLE ballot (
  id           TEXT PRIMARY KEY,     -- random UUIDv4, never sequential
  election_id  TEXT NOT NULL REFERENCES election(id) ON DELETE CASCADE,
  preferences  TEXT NOT NULL,        -- JSON: candidate ids in rank order
  receipt_hash TEXT NOT NULL,        -- sha256(token); voter holds the token
  voided       INTEGER NOT NULL DEFAULT 0
) WITHOUT ROWID;                     -- deliberately no cast_at

CREATE INDEX ballot_receipt ON ballot(receipt_hash);

-- who voted, never what. This is the mark-off on the roll.
CREATE TABLE vote_receipt (
  election_id  TEXT NOT NULL REFERENCES election(id) ON DELETE CASCADE,
  usu_id       TEXT NOT NULL,        -- = "Net Id" in the USU export
  voted_at     INTEGER NOT NULL,
  recast_count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (election_id, usu_id)  -- the double-vote guard
);

CREATE TABLE election_seal (         -- written once at close, never updated
  election_id    TEXT PRIMARY KEY REFERENCES election(id),
  closed_at      INTEGER NOT NULL,
  ballot_count   INTEGER NOT NULL,
  ballots_sha256 TEXT NOT NULL
);

CREATE TABLE election_result (       -- one row per count run
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  election_id TEXT NOT NULL REFERENCES election(id),
  computed_at INTEGER NOT NULL,
  rounds      TEXT NOT NULL,         -- full round-by-round JSON
  winners     TEXT NOT NULL,
  tie_breaks  TEXT NOT NULL,         -- every tie, method, seed or reason
  overridden  INTEGER NOT NULL DEFAULT 0,
  supersedes  INTEGER REFERENCES election_result(id)
);

CREATE TABLE audit_log (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_id TEXT,                     -- NULL for system-level events with no batch,
                                     -- e.g. a denied super-admin provisioning attempt
  role     TEXT NOT NULL,            -- super | officer | door | voter
  action   TEXT NOT NULL,
  detail   TEXT,
  at       INTEGER NOT NULL
);
```

A superseded result is never deleted. "The officer changed the tie-break and
the winner changed" must remain a visible fact with both counts attached.

**`election_seal` and `election_result` deliberately carry no `ON DELETE CASCADE`**,
unlike every other foreign key here. D1 enforces foreign keys, so once an election is
sealed it cannot be deleted — and neither can its batch, because the batch-to-election
cascade runs into the seal's restriction. Verified against the migration. The audit
record is therefore undeletable by construction rather than by policy. The asymmetry is
the point: `voter_roll` and `check_in` are purged after the AGM, while the sealed count
is permanent.

### Ballot seal definition

`ballots_sha256` is SHA-256 over the canonical serialisation of every ballot
row for the election, sorted by `id` ascending, each row rendered as
`id|preferences_json|voided` and joined with newlines. Deterministic.

**It is not currently reproducible from the exported ballot CSV.**
`toBallotsCsv` emits `ballot_id,preferences` only — no `voided` column — so a
recount can recompute the count but cannot verify that the ballots it was
handed are the sealed ones. `recount` takes `ballotsSha256` as a parameter and
uses it solely to seed tie-break draws; it never recomputes or compares it.

Closing this requires the export to carry `voided` and `recount` to recompute
the digest and refuse a mismatch. Until then the offline recount proves the
arithmetic, not the provenance — state it that way to anyone relying on it.

### Atomicity

The ballot insert and the receipt insert go into one `db.batch([...])`, which
D1 runs as a single transaction. A second submission violates
`PRIMARY KEY (election_id, usu_id)`, the transaction rolls back, and **no
ballot is written**. This replaces `attendee.voted`, which is a read-then-write
race that two browser tabs can both pass.

A recast is also one transaction: the existing ballot is marked `voided = 1`,
a new ballot row is inserted with a **newly issued receipt token**, and the
existing `vote_receipt` row is **updated** (`voted_at` refreshed,
`recast_count` incremented) rather than inserted — the primary key already
exists, so a second insert would fail. The old token stops resolving once its
ballot is voided.

### Retention

After the AGM, `voter_roll` and `check_in` are purged. That is all the
personal data. `ballot`, `election_seal` and `election_result` are anonymous
and are the audit record, so they are kept. The result: a fully defensible
count and none of the members' details.

---

## 3. The count

### Method

Single transferable vote with a Droop quota, following the Australian Senate
count. `seats = 1` collapses to instant-runoff — the Droop quota becomes a
simple majority and surplus transfers never fire — so there is one algorithm
and one test suite, not two.

```
quota = floor(valid_ballots / (seats + 1)) + 1

loop:
  count each ballot to its highest continuing preference
  if any candidate >= quota:
      elect them, highest first
      surplus        = total - quota
      transferValue  = surplus / (number of ballot papers held)   -- IGM
      transfer every one of their papers at that value
  else:
      exclude the lowest candidate(s) and transfer their papers
  until seats are filled, or continuing candidates == remaining seats
       (in which case elect them all)
```

### Surplus transfers: Inclusive Gregory Method

**Decision: IGM, as the Senate uses, not Weighted Inclusive Gregory.**

IGM computes one transfer value per distribution — surplus divided by the
*number* of papers — and applies it to every paper regardless of the value
that paper arrived with. WIGM instead divides by total *value* and moves each
paper at its own weight, producing one transfer value per weight class.

The trade-off, decided deliberately:

- **IGM is easier to hand-check.** One number per distribution, so a
  scrutineer can verify a printed round table on paper. WIGM needs papers
  sorted by incoming weight with a figure per group, and the groups multiply
  as transfers stack.
- **IGM can inflate a ballot's value.** A paper that arrived at 0.1667 can
  transfer onward at 0.25. This is a real, documented defect.

It is accepted because the defect requires multi-seat contests, stacked
transfers *and* large numbers to change an outcome — it was material in a
1.3-million-vote Senate count, not typically in a room of two hundred — while
hand-checkability and "this is what the Senate does" pay off every time.

### Precision

Integer fixed-point at five decimal places, truncated toward zero. Floating
point drifts, and drift can flip a seat. A published, fixed rule was chosen
over arbitrary-precision rationals deliberately: exact rationals would be more
precise and less auditable, because nobody can check them by hand.

### Exclusions

Bulk exclusion, as the Senate uses — but **with the safety condition the
current code omits**. Several candidates may be excluded at once only when
their combined total is below the next candidate's total, so nobody who could
have overtaken is cut. `irv.py`'s instinct to bulk-exclude was correct and
Australian; the missing safety test is the bug.

### Ties

Ties can change the result in two places: which candidate to exclude when
several are lowest, and which to elect first when several cross quota
together, since election order determines transfer order.

Resolution ladder, matching Australian practice:

1. **Countback** — compare totals at the most recent earlier round where they
   differed; the lower one loses.
2. **Seeded draw** — if level at every round including the first, draw
   deterministically from a seed over the election id, the sealed ballot
   hash and the tie-break id. The exact byte string hashed is, verbatim:

   ```
   sha256("<election_id>|<ballots_sha256>|<tie_break_id>")
   ```

   The `|` separators are part of the input and must be published with it.
   A candidate re-deriving the seed from a bare concatenation would get a
   different digest and wrongly conclude the draw had been steered.
   The tie-break id is included so two ties in one count do not resolve
   to the same index.
   Because the seed derives from the sealed ballots, anyone can re-derive it
   and verify the draw, and it cannot be manipulated without breaking the
   seal. The count never stalls.
3. **Officer override** — the returning officer may override any tie-break,
   which requires a reason, is written to `audit_log`, and appears in the
   result document. This satisfies constitutions that require lots to be
   drawn in the room.

Every tie-break is recorded in `election_result.tie_breaks` as:

```json
{
  "id": "tb-1",
  "kind": "exclusion",
  "round": 3,
  "candidates": ["<uuid>", "<uuid>"],
  "resolved": "<uuid>",
  "method": "countback",
  "resolved_at_round": 2,
  "seed": null,
  "reason": null
}
```

`kind` is `exclusion` or `election_order`; `method` is `countback`,
`seeded_draw` or `officer_override`. `id` is what the override endpoint takes
as `tie_break_id`.

The seeded draw is defined exactly: sort the tied candidate ids
lexicographically and take `index = seed_int mod n`, where `seed_int` is the
first eight bytes of `sha256(election_id || ballots_sha256 || tie_break_id)`
read big-endian. The tie-break id is included so that two ties within one
count do not resolve to the same index.

A sealed result therefore explains its own tie-breaks without anyone needing
to remember them.

### Ballot validity

**Senate-style minimum: a ballot must rank at least `seats` candidates.**
(The Senate requires six above the line and twelve below.) Shorter ballots are
rejected at submission, in the UI and again server-side. Beyond the minimum,
preferences are optional; a ballot exhausts when all its preferences are
elected or excluded, and moves to non-transferable.

The quota is fixed from the initial valid total and never recomputed, so
exhaustion can leave the final seat filled below quota. That is standard, and
handled by the "continuing candidates == remaining seats" rule.

### Invariant

At every round, `sum(candidate totals) + non-transferable == initial valid
total`. Votes are conserved or the count throws. Asserted in code, not only in
tests — it catches most transfer bugs on the spot.

---

## 4. Lifecycle and flows

### Election states

| State | Officer can | Voters can | Results |
| --- | --- | --- | --- |
| `draft` | add, edit, remove candidates; set `seats` | nothing | none |
| `open` | see turnout only | vote, verify, recast | **none** |
| `closed` | view result, override a tie-break | nothing | sealed |

Two rules carry real weight:

- **Candidates freeze at `open`.** Adding a candidate after fifty ballots
  means those fifty voters never had the chance to rank them, and their
  ballots are silently incomparable. `add_candidate` currently works at any
  time; this is blocked outright.
- **No tally exists until `closed`, and closing is irreversible.** Today an
  officer can watch the result develop and choose when to stop, which makes
  every other control decorative. Turnout is visible while open; the count is
  not.

### Door flow (`door` role)

Sign in with the door password. Fetch the roll once — roughly 1,300 rows,
about 50KB — and filter client-side on each keystroke, so search is instant
and keeps working if venue wifi drops mid-queue. Tap a name to check in. Live
quorum reads `checked_in / eligible`. This role cannot reach elections,
candidates or any count.

### Voter flow

Voters authenticate with **USU ID plus surname**, both matching the roll.
Looking a voter up by USU ID alone and echoing their name back would be an
enumeration oracle over a seven-digit space; requiring the surname gives
nothing away on a wrong guess. Rate-limited on top.

Check-in is verified, then: list of `open` elections, rank candidates, submit.
A **receipt token is shown once** and also written to `localStorage`.

**The receipt confirms inclusion only.** It proves a ballot of theirs is
recorded and counted, and lets them void it while the election is open. It
**never displays their preferences.** Australia deliberately has no voter
receipt, because a receipt that proves how you voted enables vote-buying and
coercion; society elections with factions are not immune. Confirming inclusion
keeps the "my vote wasn't counted" dispute solvable while remaining useless to
a coercer.

Voiding sets `voided = 1`, increments `recast_count`, and lets the voter cast
again. Voided ballots stay in the table so the seal hash still covers them.

### Officer flow

Import roll (with a diff — "1,298 eligible, 4 excluded" — shown before
anything commits) → create elections and set seats → add candidates → open →
watch turnout → close → review the result with full round-by-round transfers,
exhaustion and tie-breaks → export.

Exports: attendance CSV, **anonymous ballot CSV** so a disputed count can be
re-run offline against `packages/core`, and the sealed result as JSON.

### The ballot UI is rebuilt, not ported

Ranking is currently *checkboxes* whose order comes from click sequence
(`toggleRank` appends to an array). No rank number is visible while clicking,
and changing preference 2 means unticking everything after it. It becomes an
explicit ranked list: tap to add with a visible ordinal, reorder with arrows
or drag, remove individually. Usable with a thumb on a phone, reachable by
keyboard, and it states the minimum-preferences rule plainly.

---

## 5. API surface

**Public**

```
GET    /api/batches                         -> [{slug, name, branding}]
GET    /api/batches/by-slug/:slug           -> {id, slug, name, branding}
GET    /api/batches/:id/elections           -> [{id, name, seats, status, candidates}]
POST   /api/batches/:id/voter/session       {usu_id, surname} -> cookie + {first_name}
POST   /api/batches/:id/elections/:eid/ballots  {preferences[]} -> {receipt_token}
GET    /api/receipts/:token                 -> {status, election_name}   (no preferences)
POST   /api/receipts/:token/void
```

**Door session**

```
POST   /api/batches/:id/door/session
GET    /api/batches/:id/roll
POST   /api/batches/:id/check-in            {usu_id}
DELETE /api/batches/:id/check-in/:usu_id
GET    /api/batches/:id/quorum
```

**Officer session**

```
POST   /api/batches/:id/officer/session
POST   /api/batches/:id/roll/preview        (multipart CSV) -> diff
POST   /api/batches/:id/roll                (commit)
DELETE /api/batches/:id/roll                (purge PII after the AGM)
PATCH  /api/batches/:id/branding
POST   /api/batches/:id/logo
POST   /api/batches/:id/elections           {name, seats}
POST   /api/batches/:id/elections/:eid/candidates      (draft only)
PATCH  /api/batches/:id/elections/:eid/candidates/:cid (draft only)
DELETE /api/batches/:id/elections/:eid/candidates/:cid (draft only)
POST   /api/batches/:id/elections/:eid/open
POST   /api/batches/:id/elections/:eid/close
GET    /api/batches/:id/elections/:eid/turnout
GET    /api/batches/:id/elections/:eid/result
POST   /api/batches/:id/elections/:eid/result/override  {tie_break_id, resolved_id, reason}
GET    /api/batches/:id/elections/:eid/attendance.csv
GET    /api/batches/:id/elections/:eid/ballots.csv
GET    /api/batches/:id/attendance.csv
```

**Super admin**

```
POST   /api/batches                         (requires SUPER_ADMIN_KEY)
```

The voter's `usu_id` is carried by the session cookie and never appears in a
ballot request body.

**`resolved_id`, not `winner_id`.** The override field was named `winner_id`
until 2026-09-21, and the name was wrong in a way that would have produced
confidently incorrect results. It carries whatever `TieBreakRecord.resolved`
carries, and that is not always the candidate who benefits:

- `kind: 'exclusion'` — the id is the candidate to **exclude**. The tie is over
  who goes out, so the resolved id is the one who loses.
- `kind: 'election_order'` — the id is the candidate to elect **first**, whose
  surplus is distributed first.

A UI labelled "pick the winner" would therefore collect the exact opposite of
the officer's intent on an exclusion tie, and the result would look right. The
API echoes each tie's `kind` in the result document so the control can be
labelled truthfully.

---

## 6. Security posture

### Exposure

| Today | Fix |
| --- | --- |
| `GET /elections` and `/elections/<eid>` return every ballot and every attendee's name and USU ID, unauthenticated | Public route returns `{id, name, seats, status, candidates}` only. Ballots leave the API solely as an anonymous export to an authenticated officer. Roll data never appears on a public route. |
| `POST /batches/<id>/logo` has no auth decorator | Officer session required; R2 key is a content hash, so one society cannot overwrite another's `logo.png`; validated by magic bytes, not by `allowed_file()`'s extension check |
| `POST /api/batches` open to the world | Requires the `SUPER_ADMIN_KEY` secret |
| `GET /api/batches` lists every tenant publicly | Returns slug and branding only |
| `VITE_ADMIN_TOKEN` is baked into the public bundles | Removed. No secret ever lives in a `VITE_` variable. |

### Authentication

| Today | Fix |
| --- | --- |
| Tokens stored in plaintext, compared with `!=` | PBKDF2-HMAC-SHA256 via WebCrypto, ~210k iterations, constant-time compare. Argon2 and bcrypt are not used: both need WASM builds on Workers. |
| Password sent on every request, held in `localStorage` | Signed `HttpOnly` `Secure` `SameSite=Strict` cookie, scoped to one batch and one role, short TTL |
| `CORS(app)` — fully open | Explicit origin allowlist, credentials mode |
| USU ID alone identifies a voter | USU ID plus surname, both matching the roll |
| No rate limiting anywhere | KV-backed limits on sign-in, roll lookup and ballot submission |

### Integrity

| Today | Fix |
| --- | --- |
| Ballot order and attendee order correlate | `WITHOUT ROWID`, random UUID key, no ballot timestamp |
| `attendee.voted` is a read-then-write race two tabs both pass | `PRIMARY KEY (election_id, usu_id)` inside a D1 transaction |
| Tally readable at any moment | Only when `status = 'closed'`; closing is irreversible |
| Candidates addable mid-vote | Frozen at `open` |
| `attendance()` raises `TypeError` and reads a `DB["elections"]` that does not exist | Rewritten |
| No audit trail | `audit_log` on every privileged action |
| No tests | Vitest units, integration against real D1, STV known-answer corpus |

---

## 7. The USU CSV import

The export at `user_download_members_usu_*.csv` is **malformed**: the header
has 28 columns, every data row has 29. Fields shift by one from
`Membership End Date` onward.

The importer reads four columns: `Net Id`, `First Name`, `Last Name`,
`Left Group`. The first three sit at indices 1, 3 and 4 — before the shift —
so they parse correctly either way.

`Left Group` sits after the shift, and is the one that bites. A naive parse
reads the wrong column and returns `0` for all 1,302 rows, so departed members
silently gain voting rights. In the sample export this is exactly four people.

This is now the sole reason the realignment logic exists, which makes it easy
to under-value and easy to break later. It gets a named test with a fixture of
the real header, asserting exactly four exclusions. If USU ever fixes the
export, the importer must handle both the 28- and 29-column forms.

Import is idempotent: upsert on `(batch_id, usu_id)`, so re-importing a
corrected export is safe.

---

## 8. Frontend

React 19 and Vite 7 with TypeScript throughout. The voter app aliases React to
Preact for a roughly 4KB runtime, since it is what a thousand-plus people load
on phones and is the security-critical surface.

What actually needed fixing was never the framework:

- **There is no CSS.** Not one stylesheet; every element is styled inline on
  browser-default typography. This is essentially the whole reason the system
  looks dated.
- **No TypeScript.** For code computing election results from ballot shapes,
  this is the single largest available improvement.
- **Errors are invisible.** `{/* {error && <p>{error}</p>} */}` is commented
  out in `App.jsx`, `BatchDetailPage.jsx`, `BatchManager.jsx` and
  `BatchDetail.jsx`, while nine `console.log` calls stand in for user-facing
  error handling. A voter whose ballot fails to submit sees nothing happen.
- **axios** for eighteen requests across the two apps. Native `fetch`
  does this.
- **Everything is duplicated** across the two apps — `logoSrc.js` twice, the
  API-base regex twice, no shared types. `old_App.jsx` (186 lines) is still in
  the tree and should not survive.

---

## 9. Testing

`packages/core` carries the weight:

- **Known-answer corpus** from published Senate and Scottish council counts.
- **Property tests:** vote conservation at every round, termination, exactly
  `seats` winners, determinism (identical input produces identical output
  including tie-breaks).
- **Edge cases:** all candidates tied; every ballot exhausted;
  `seats >= candidates`; zero ballots; a single candidate.
- **Differential test** running the new TypeScript count against the existing
  `irv.py` at `seats = 1`, proving nothing changed except the tie fix and the
  bulk-exclusion safety condition.
- **CSV realignment** against a fixture of the real 29-column header.

`apps/api` is tested with `@cloudflare/vitest-pool-workers` against real D1,
covering: double submission from two concurrent requests, voting in `draft`
and `closed` states, tally access while `open`, adding a candidate after
`open`, door role reaching officer routes, and every unauthenticated route
returning no ballot or roll data.

---

## 10. Rollout

No data migration — the current store is in memory. The only artefact to move
is `backend/uploads/BGS_logo_horizontal2.jpg` into R2.

1. Stand up the Worker, D1 and R2 on a staging hostname.
2. Run a full mock AGM against staging: import the real CSV, check in, vote,
   close, count, export, verify the exported ballots re-count to the same
   result offline.
3. Point `api.dalyell.com.au`, `vote.dalyell.com.au` and
   `admin.dalyell.com.au` at the new deployments.
4. Retire the Render service and both Vercel projects.

The old Flask code stays in git history and `irv.py` remains as the reference
for the differential test.

---

## 11. Known risks

- **`WITHOUT ROWID` must not be lost.** Migrations are hand-written SQL
  precisely so this clause is visible and owned. A test asserts `ballot` is
  created with it, because losing it silently reintroduces the correlation
  leak and nothing else would fail.
- **IGM's known defect.** Accepted with eyes open, documented in the result
  export so a challenged count can be discussed honestly.
- **Shared per-batch passwords** mean admin actions are attributable to a role
  and not a person. `audit_log` records the role. Accepted; real accounts were
  considered and rejected as too much friction on AGM night.
- **The seeded draw is only as trustworthy as the seal.** If ballots could be
  altered after close, the seed changes with them. The seal being written once
  and never updated is what makes the draw verifiable.
- **Check-in is a single point of failure on the night.** If the door station
  fails, nobody can vote. The roll fetch is client-side cached, and the officer
  can check members in as a fallback.
