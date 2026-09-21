# election-code rewrite — session handoff

**Last updated:** 2026-09-21 (Plan 2a complete; Plan 2b not started)
**Branch:** `rewrite/core-counting` (NOT merged, NOT mergeable — see Open Critical)
**Resume from:** this file, then the spec, then the plans. This conversation is not needed.

---

## 1. Where things stand

| Item | State |
| --- | --- |
| Spec | `docs/superpowers/specs/2026-09-16-election-code-rewrite-design.md` — approved, amended twice |
| Plan 1 — `packages/core` | **Executed.** 12 tasks, 14 fix rounds, 1 fix wave. 118/118 tests, typecheck clean, zero deps |
| Plan 2a — `apps/api` foundation | **COMPLETE.** 6 tasks, 5 fix rounds + 1 fix wave. api 105/105, typecheck clean, whole-branch review passed |
| Plan 2b — `apps/api` endpoints | Not written. Scope listed at the end of the 2a plan |
| Plan 3 — frontends | Not started |
| Legacy code | `backend/`, `admin-frontend/`, `voter-frontend/` still present. `backend/irv.py` MUST remain until the differential test is retired |
| Execution ledger | `.superpowers/sdd/2026-09-16-core-counting-library/progress.md` (gitignored, on disk only) |

**Verify state on resume:**
```bash
git log --oneline main..HEAD | wc -l     # expect 27
npm run -w @election/core test           # expect 118/118
npm run -w @election/api test            # expect 105/105
npm run -w @election/core typecheck      # expect clean
```

---

## 2. OPEN CRITICAL — do not merge, do not run a multi-seat election

**A surplus flows onto a candidate already lifted to quota by an earlier surplus in the same round.**
`packages/core/src/count.ts` — statuses are frozen for the whole `electionOrder` loop, so no candidate
can be elected *between* two surplus distributions.

Reproduction — 6 candidates, 4 seats, 40 ballots (`18×[a,c,d] 12×[b,c,e] 4×[d] 3×[e] 3×[f]`), quota 9:

```
r1: a=9.00000* b=9.00000* c=12.00000 ...
    a's surplus takes c to exactly 9.00000 (= quota)
    b's surplus is poured onto c anyway -> 12.00000
r2: c's manufactured 3.00000 surplus redistributed by C's preferences
WINNERS a,b,c,d          Senate rule (CEA s273(8)/(9)): a,b,c,e
```

**Corroboration that this is a real divergence:** the `election_order` tie-break is currently **inert**.
Overriding the same tie in opposite directions yields byte-identical round tables, because `place()`
only pushes onto continuing candidates and no status changes inside the loop. Spec §3 says
"election order determines transfer order". Here it determines nothing.

**Fix direction:** give the count sub-round ("count") granularity — after each individual surplus,
elect any continuing candidate now at/above quota, then distribute the largest pending surplus next.
Concretely, calling `assertNoContinuingAtQuota(n)` *inside* the `electionOrder` loop makes the fixture
above throw. Related, same root cause, lower severity: bulk exclusion transfers all excluded
candidates' papers in one step.

**Status by seat count:** correct at `seats = 1` (no surplus code runs; 197/200 differential agreement
with `irv.py`). Known-wrong at `seats >= 2`.

---

## 3. Defect found in the CURRENT PRODUCTION system

`backend/irv.py` bulk-eliminates every tied-lowest candidate with no safety condition. Verified case:
a 4-candidate race with three tied for last declared a winner on **28% of first preferences** in one
round, 72% of ballots never transferred. Any past election with a tie for last may have returned the
wrong winner. Ballots were in-memory; that data is gone.

---

## 4. Known gap: no known-answer corpus

Verification rests on 200 randomised property elections plus a differential against `irv.py` at
`seats = 1` only — so **no surplus-transfer code is compared against anything**. The property tests
assert invariants only; a wrong count satisfying all of them passes. This is not hypothetical: the
Critical above and its predecessor both passed all 200.

**Action before any `seats >= 2` election:** enter two published multi-seat counts (Scottish council
ward results publish full round-by-round transfer tables; the AEC publishes worked Senate examples)
as fixtures. Estimated an afternoon. Would have caught both defects on the first run.

---

## 5. Process lesson worth carrying into Plans 2 and 3

The first Critical was in the **plan**, transcribed faithfully. Every per-task review compared code to
plan, and the code matched. **Nothing compared plan to spec.** Add a plan-vs-spec check before
execution, not only code-vs-plan during it.

---

## 6. Forward constraints Plan 2 must honour

1. **Block opening an election with zero candidates.** `minimumPreferences` is now `Math.max(1, ...)`
   so the library is safe standalone, but the API must still refuse it.
2. **Candidate ids must never contain `|`.** `toBallotsCsv` throws on this; ids are `crypto.randomUUID()`.
3. **`candidatesCsv` must be the complete candidate list** for the ballots it accompanies — `recount`
   refuses a preference naming an absent candidate.
4. **Spec §5 names the override field `winner_id`, but for `kind: 'exclusion'` the id is the candidate
   to EXCLUDE.** A UI labelled "pick the winner" collects the opposite of the officer's intent. Rename
   in the API (`resolved_id`), or translate by `kind`.
5. **`CountInput.overrides` is `Record<string, { candidateId, reason }>`** — the officer's reason is
   required and reaches `TieBreakRecord.reason`.
6. **The ballot export carries no `voided` column**, so a recount proves the arithmetic, not the
   provenance (spec §2 documents this). Closing it needs the column plus a digest comparison.
7. **`WITHOUT ROWID` on `ballot`** is the whole basis of the secret-ballot guarantee. Migrations are
   hand-written SQL precisely so this clause is visible. A test must assert the table has it.
8. **No ORM.** `wrangler d1 migrations` + D1's prepared-statement API + hand-written row types.
9. **All three deployments must share one apex domain.** `SameSite` is judged by
   registrable domain, not subdomain. On `*.workers.dev` / `*.pages.dev` / `*.vercel.app`
   the session cookie is never sent and every authenticated request fails silently.
   Auth cannot be tested on preview URLs. CORS must send an explicit origin with
   `Access-Control-Allow-Credentials: true`, never `*`.

---

## 6b. Constraints Plan 2b must honour (from the Plan 2a whole-branch review)

1. **A session cookie is not proof of eligibility.** A voter session proves only that
   someone passed USU-id + surname at time T. Spec §5 allows an officer to un-check-in a
   voter *after* their cookie was issued, and the post-AGM roll purge removes rows while
   cookies stay valid for their full TTL. **Re-verify `eligible` and `check_in` inside the
   ballot transaction on every submission.** Never treat the cookie as the eligibility check.

2. **`requireRole` binds to the literal path param `id`.** Every 2b route must use
   `/api/batches/:id/...`, not `:batchId`. A mismatch produces a middleware that denies
   everything — it fails closed, so a test catches it, but it reads as a mysterious 403.
   If you mount sub-routers under `/api/batches/:id`, verify parent-param inheritance
   rather than assuming it.

3. **Rate limiting is load-bearing for two things, not one.** Both sign-in routes are
   unauthenticated, cost ~210k PBKDF2 iterations per call, and write an `audit_log` row per
   failure. Unthrottled that is both a billable-CPU amplifier and a way for an anonymous
   caller to flood the audit trail until real entries are unreadable — degrading the exact
   artifact the audit design exists to produce. KV limits must cover `officer/session` and
   `door/session` explicitly, not only roll lookup and ballot submission as §6 words it.

4. **Constrain `AuditEntry.detail` before writing any 2b handler — this is the sharpest
   unguarded edge in the foundation.** `detail` is typed `unknown` and JSON-stringified
   straight into a permanent, undeletable table. Two consequences:
   - The natural implementation of `POST /api/batches/:id/check-in {usu_id}` records the
     usu_id in `detail`. That leaves personal identifiers in a table the retention rule
     cannot purge, **breaking spec §2's claim that `voter_roll` and `check_in` are all the
     personal data held**.
   - `audit_log.id` is `AUTOINCREMENT` and `at` is a timestamp, so a ballot-submission
     audit row carrying a ballot id — or a usu_id alongside a ballot event — **rebuilds
     exactly the correlation join that `WITHOUT ROWID` and the absent `cast_at` exist to
     prevent**.

   Type `detail` to an explicit allow-list, or enforce a documented rule: never a usu_id,
   never a ballot id.

5. **The ballot eligibility re-check cannot be a read-then-write.** Constraint 1 above
   requires re-verifying `eligible` and `check_in` at submission, but doing it as a
   separate `.first()` before the transaction reintroduces precisely the race spec §6
   claims to fix in `attendee.voted`. Fold it into the insert:
   `INSERT ... SELECT ... WHERE EXISTS (...)`.

6. **Add `POST /api/batches` to the KV rate-limit list.** The denied-attempt audit row
   turned it from a zero-DB-work 401 into an *unauthenticated D1 write*. The row is
   entirely attacker-uncontrolled and `NULL batch_id` keeps it out of batch-scoped
   exports, but it is unbounded.

7. **Add a JSON `app.onError`.** `src/index.ts` has none, so a thrown error returns
   hono's `text/plain` "Internal Server Error" and a frontend calling `res.json()` throws
   on the parse instead of surfacing the 500. Needed before 2b adds handlers that throw.

8. **Two cheap one-liners worth taking:** tighten `requireRole`'s other-role lookup to
   assert `role` and `batchId` on the token it finds (its comment already claims this);
   and enforce the 32-character `SESSION_SECRET` floor in `verifySession` too, so a
   misconfigured deployment accepts *nothing* rather than accepting only forgeries.

9. **If 2b fetches exports rather than navigating to them**, add
   `exposeHeaders: ['content-disposition']` to the CORS config, or the frontend cannot
   read the filename off `attendance.csv` / `ballots.csv`.

10. **Write `ORDER BY id` explicitly** in the seal serialisation and the ballot export.
   Because `ballot` is `WITHOUT ROWID`, physical order is *already* UUID order, so it will
   be tempting to omit it. Spec §2 defines the digest as sorted by `id` ascending — inherit
   that from the query, not from a storage detail.

11. **Once `0001_initial.sql` is applied to the production D1, it is immutable.** Editing an
   applied migration leaves the deployed database unchanged while the local test database
   silently diverges. All later schema changes go in a new numbered migration.

---

## 7. `packages/core` public surface (what Plan 2 consumes)

```
count, recount, toBallotsCsv, toCandidatesCsv
validateBallot, minimumPreferences, droopQuota
parseUsuExport, RollMember, ImportResult          (ImportResult has `skipped`)
deriveSeed, seededDraw                            (a candidate verifies a draw)
format, Fixed
Candidate, CountBallot, CandidateStatus, RoundCount, Round,
TieBreakKind, TieBreakMethod, TieBreakRecord, CountInput, CountResult
VERSION
```

Deliberately NOT exported: `bulkExclusionSet`, `countback`, `History`, `SCALE`, `ZERO`, `fromInt`,
`mul`, `div` — algorithm internals.

---

## 8. Decisions that are settled (do not relitigate)

- npm workspaces, not pnpm. Node 20+.
- Two CSV tokenizers stay separate: `usu-import` partially recovers from a malformed third-party
  export; `recount` fails closed on corruption of our own output. Opposite policies by design.
- IGM surplus transfers, not WIGM — one transfer value per distribution stays hand-checkable.
- Fixed-point bigint, 5dp, truncated. Never floating point.
- Secret ballot: `ballot` has no voter reference and no timestamp; `vote_receipt` is the roll mark-off.
- Receipts confirm inclusion only, never preferences.
- Roll import + door check-in both required for eligibility.

---

## 9. Plan 2a known weakness

Tasks 2 and 5 specify their implementation in prose plus exhaustive tests rather than
verbatim code. The schema is quoted exactly in spec §2 (10 `CREATE TABLE` statements,
`WITHOUT ROWID` included) so Task 2's pointer is precise; Task 5's router description is
weaker. In both cases the tests are complete and carry the contract. If an implementer
reports ambiguity there, believe them and tighten the brief rather than pushing on.

## 10. SDD workspaces

- Plan 1: `.superpowers/sdd/2026-09-16-core-counting-library/progress.md` (27 rulings)
- Plan 2a: `.superpowers/sdd/2026-09-17-api-foundation/progress.md`

Both are gitignored. This file is the committed summary; the ledgers hold the detail.
