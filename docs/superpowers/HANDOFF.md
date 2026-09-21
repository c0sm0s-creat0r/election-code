# election-code rewrite — session handoff

**Last updated:** 2026-09-21 (Plan 2b COMPLETE; multi-seat Critical fixed; Plan 2c written, not executed)
**Branch:** `rewrite/core-counting` (not merged; no open Critical)
**Resume from:** this file, then the spec, then the plans. This conversation is not needed.
**Next action:** execute Plan 2c (`docs/superpowers/plans/2026-09-21-api-result-path.md`). Do the
plan-vs-spec check in §6 first — it caught a blocking defect in 2b — and read §2 before Task 1.

---

## 1. Where things stand

| Item | State |
| --- | --- |
| Spec | `docs/superpowers/specs/2026-09-16-election-code-rewrite-design.md` — approved, amended twice |
| Plan 1 — `packages/core` | **Executed.** 12 tasks, 14 fix rounds, 1 fix wave. 118/118 tests, typecheck clean, zero deps |
| Plan 2a — `apps/api` foundation | **COMPLETE.** 6 tasks, 5 fix rounds + 1 fix wave. api 105/105, typecheck clean, whole-branch review passed |
| Plan 2b — voting path | **COMPLETE.** 7 tasks, amended once before execution (see §2 below). api 245/245, typecheck clean |
| Plan 2c — result path | **Plan written**, not executed. `docs/superpowers/plans/2026-09-21-api-result-path.md` — 7 tasks |
| Plan 3 — frontends | Not started |
| Legacy code | `backend/`, `admin-frontend/`, `voter-frontend/` still present. `backend/irv.py` MUST remain until the differential test is retired |
| Execution ledger | `.superpowers/sdd/<plan>/progress.md`, one per plan (gitignored, on disk only) |

**Verify state on resume:**
```bash
npm run -w @election/core test            # expect 135/135
npm run -w @election/api test             # expect 245/245
cd packages/core && npx tsc --noEmit      # expect clean
cd apps/api && npx tsc --noEmit           # expect clean
```

`npm run -w @election/api typecheck` works too, but note it resolves `tsconfig.json` relative to the
workspace directory, so run it from `apps/api` if you invoke `tsc` by hand. Do not trust the commit
count as a state check — it moves with every docs commit.

---

## 2. What Plan 2b changed about the data model — READ BEFORE PLAN 2c

**Migration `0002_live_receipt_hash.sql` adds `vote_receipt.live_receipt_hash`.**

Plan 2b's Task 7 could not be implemented as written. It prescribed
`UPDATE vote_receipt SET recast_count = recast_count + 1 WHERE ...` with no `WHERE` clause, and none
was possible: `ballot` carries no voter reference — that absence *is* the secret ballot — so a void
keyed on `receipt_hash` alone cannot find the mark-off row to clear. Task 6's plain `INSERT` then
meant a post-void re-cast hit the primary key, so Tasks 6 and 7 could not both pass.

The user chose, from three options and after being shown the cost of each, to store the live
ballot's `receipt_hash` on `vote_receipt`. **The cost: while a ballot is live, the database holds a
join from `usu_id` to that ballot's preferences** — the correlation spec §2 drops `cast_at` and
ROWID to prevent — readable by anyone with database access. It is bounded, and **Plan 2c must keep
it bounded**:

1. **Closing an election MUST `UPDATE vote_receipt SET live_receipt_hash = NULL` for that
   election**, in the same transaction that writes `election_seal`. After close nothing can be
   voided, so the link has no remaining purpose and must not outlive the count. This is the single
   most important thing in 2c's brief.
2. **The post-AGM purge must cover `vote_receipt`.** Spec §2's retention paragraph says `voter_roll`
   and `check_in` are purged and that "that is all the personal data" — it does not name
   `vote_receipt`, whose `usu_id` is personal data. The claim is false until the purge includes it.
   This was already true before 0002; the new column makes it worse.
3. **Never select, export or log `live_receipt_hash`.** A partial UNIQUE index stops two receipt
   rows claiming one ballot; nothing stops a careless `SELECT *`.

What the choice bought, beyond simplicity: because the receipt row is found *through* the hash, a
void always clears the **true owner's** mark-off. A stolen token disenfranchises its owner — which
spec §5's public void endpoint already accepts — but cannot mint a second live ballot. Two tests in
`tests/receipts.test.ts` pin exactly that.

**Other carried items for 2c:**

- **An officer cannot list their own draft elections.** `GET /api/batches/:id/elections` is public
  and returns only `open` and `closed`, per spec §5, which has no officer listing at all. After a
  page reload an officer has only the id from the create response. I deliberately did not invent
  one: making the public route's body depend on a cookie is a cache hazard (a shared cache could
  serve a draft-bearing response to anyone), so it needs its own path and belongs with 2c's other
  officer routes.
- **`recast_count` is incremented by the void, not by the re-cast** (spec §4's wording). A voter who
  voids and never returns therefore has `recast_count = 1` and no live ballot. Any turnout or
  participation figure must count `vote_receipt` rows with a live ballot, not `recast_count`.
- **Voter sign-in does not audit an unauthenticated miss**, deliberately, unlike staff sign-in — the
  300/10min limit cannot be tightened (CGNAT), so auditing every wrong guess is a way to bury the
  trail. It *does* audit a refusal that named a real roll member. If 2c adds a voter-facing route,
  follow the same rule.
- **`tests/privacy.test.ts` asserts Plan 2b's cross-cutting criteria** over a database that has been
  through a whole election, and carries an action inventory. **A new audited action fails that
  inventory test** — that is the reminder to decide, deliberately, that the new action carries no
  identifier.
- Test fixtures are bundled with Vite's `?raw`, never `node:fs`: the tests run inside the workers
  runtime, which cannot reach the host filesystem.

---

## 3. RESOLVED (was Critical) — multi-seat surplus defect, fixed 2026-09-21 in 1227df5

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

**FIXED** in `1227df5` by giving the count sub-round granularity: elect everyone at quota,
distribute the largest pending surplus, then immediately elect anyone that transfer lifted to
quota and add their surplus to the pending set. CEA s273(8) elects at that count; s273(1) then
stops them being a continuing candidate, so later surpluses skip them.

Verified: the 40-ballot fixture now returns `a,b,c,e` with a, b **and** c elected in round 1;
the 11-ballot fixture returns `c,d,b`. `seats = 1` is unchanged — the `irv.py` differential
still diverges on exactly cases 71, 120, 179 with the same 14 null-winner cases.

`election_order` was **inert** before this fix (two opposite resolutions of the same tie produced
byte-identical round tables, because no status changed inside the distribution loop). It is now
load-bearing, with a test showing the same tie resolved each way moving the last seat.

---

## 4. Defect found in the CURRENT PRODUCTION system

`backend/irv.py` bulk-eliminates every tied-lowest candidate with no safety condition. Verified case:
a 4-candidate race with three tied for last declared a winner on **28% of first preferences** in one
round, 72% of ballots never transferred. Any past election with a tie for last may have returned the
wrong winner. Ballots were in-memory; that data is gone.

---

## 5. Known gap: no known-answer corpus

Verification rests on 200 randomised property elections plus a differential against `irv.py` at
`seats = 1` only — so **no surplus-transfer code is compared against anything**. The property tests
assert invariants only; a wrong count satisfying all of them passes. This is not hypothetical: the
Critical above and its predecessor both passed all 200.

**Action before any `seats >= 2` election:** enter two published multi-seat counts (Scottish council
ward results publish full round-by-round transfer tables; the AEC publishes worked Senate examples)
as fixtures. Estimated an afternoon. Would have caught both defects on the first run.

---

## 6. Process lesson worth carrying into Plan 2c and Plan 3

The first Critical was in the **plan**, transcribed faithfully. Every per-task review compared code to
plan, and the code matched. **Nothing compared plan to spec.** Add a plan-vs-spec check before
execution, not only code-vs-plan during it.

---

## 7. Forward constraints Plan 2 must honour

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
   provenance (spec §2 documents this). **Plan 2c Task 4 closes it** — note that adding the column
   also requires fixing `recount`, which refuses a row with an unexpected field count and has no
   notion of a voided ballot, so today it would both reject the file and count voided ballots.
7. **`WITHOUT ROWID` on `ballot`** is the whole basis of the secret-ballot guarantee. Migrations are
   hand-written SQL precisely so this clause is visible. A test must assert the table has it.
8. **No ORM.** `wrangler d1 migrations` + D1's prepared-statement API + hand-written row types.
9. **All three deployments must share one apex domain.** `SameSite` is judged by
   registrable domain, not subdomain. On `*.workers.dev` / `*.pages.dev` / `*.vercel.app`
   the session cookie is never sent and every authenticated request fails silently.
   Auth cannot be tested on preview URLs. CORS must send an explicit origin with
   `Access-Control-Allow-Credentials: true`, never `*`.

---

## 8. Constraints from the Plan 2a review — ALL NOW ADDRESSED (kept for the reasoning)

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

4. **DONE (823a97d) — `AuditEntry.detail` is now an allow-list.** Kept here because the
   *reasoning* still binds every new audited action: adding one means adding a variant, and
   the rule is **never a usu_id, never a ballot id, never a preference list**. Why: `detail` is typed `unknown` and JSON-stringified
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

**Status of §6b at the end of Plan 2b:** (1) done — eligibility is re-verified in the insert;
(2) done — every gated route uses `:id`; (3) done — Task 1 covers both sign-in routes explicitly;
(4) was already done in 823a97d and the rule held for every new action; (5) done —
`INSERT ... SELECT ... WHERE EXISTS`, no read-then-write; (6) done — `POST /api/batches` is limited
at 10/hour; (7) was already done in 1dd27ad; (8) done in Plan 2a's fix wave; (9) `exposeHeaders:
['content-disposition']` is already in the CORS config, so 2c's exports are covered; (10) still
**open and owned by 2c** — write `ORDER BY id` explicitly in the seal serialisation and the ballot
export; (11) verified — `0001_initial.sql` was not touched by Plan 2b, and 0002 is a new file.

---

## 9. `packages/core` public surface (what Plan 2 consumes)

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

## 10. Decisions that are settled (do not relitigate)

- npm workspaces, not pnpm. Node 20+.
- Two CSV tokenizers stay separate: `usu-import` partially recovers from a malformed third-party
  export; `recount` fails closed on corruption of our own output. Opposite policies by design.
- IGM surplus transfers, not WIGM — one transfer value per distribution stays hand-checkable.
- Fixed-point bigint, 5dp, truncated. Never floating point.
- Secret ballot: `ballot` has no voter reference and no timestamp; `vote_receipt` is the roll mark-off.
- Receipts confirm inclusion only, never preferences.
- Roll import + door check-in both required for eligibility.

---

## 11. Plan 2a known weakness

Tasks 2 and 5 specify their implementation in prose plus exhaustive tests rather than
verbatim code. The schema is quoted exactly in spec §2 (10 `CREATE TABLE` statements,
`WITHOUT ROWID` included) so Task 2's pointer is precise; Task 5's router description is
weaker. In both cases the tests are complete and carry the contract. If an implementer
reports ambiguity there, believe them and tighten the brief rather than pushing on.

## 12. SDD workspaces

- Plan 1: `.superpowers/sdd/2026-09-16-core-counting-library/progress.md` (27 rulings)
- Plan 2a: `.superpowers/sdd/2026-09-17-api-foundation/progress.md`
- Plan 2b: `.superpowers/sdd/2026-09-21-api-voting-path/progress.md` — the plan-vs-spec check that
  found the recast defect, the three options put to the user, and every ruling taken during execution

All three are gitignored. This file is the committed summary; the ledgers hold the detail.
