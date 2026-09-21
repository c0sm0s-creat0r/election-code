# election-code rewrite — session handoff

**Last updated:** 2026-09-21 (**ALL PLANS COMPLETE** — api, core, voter, admin, e2e. 666 unit tests + 1 browser smoke)
**Branch:** `rewrite/core-counting` (not merged; no open Critical)
**Resume from:** this file, then the spec, then the plans. This conversation is not needed.
**Next action:** nothing is planned. The rewrite is feature-complete against the spec. Before a real
AGM runs on it, the two things that matter are in §5 (**the missing known-answer corpus for multi-seat
counts** — do this first) and `docs/superpowers/LIMITATIONS.md`. The legacy `backend/`,
`admin-frontend/` and `voter-frontend/` directories are still present and can be retired once
`backend/irv.py` is no longer needed by the differential test.

---

## 1. Where things stand

| Item | State |
| --- | --- |
| Spec | `docs/superpowers/specs/2026-09-16-election-code-rewrite-design.md` — approved, amended twice |
| Plan 1 — `packages/core` | **Executed.** 12 tasks, 14 fix rounds, 1 fix wave. 118/118 tests, typecheck clean, zero deps |
| Plan 2a — `apps/api` foundation | **COMPLETE.** 6 tasks, 5 fix rounds + 1 fix wave. api 105/105, typecheck clean, whole-branch review passed |
| Plan 2b — voting path | **COMPLETE.** 7 tasks, amended once before execution (see §2 below). api 245/245, typecheck clean |
| Plan 2c — result path | **COMPLETE.** 7 tasks + 1 added (§2 below). api 359/359, typecheck clean. `apps/api` is complete against spec §5 — all 33 routes |
| Plan 2d — guests + door additions | **COMPLETE.** 4 tasks. api 399/399, typecheck clean. Migration `0004` |
| Frontends design | `docs/superpowers/specs/2026-09-21-frontends-design.md` — approved. Mobile-first, plain-CSS tokens, door as a lazy admin route |
| Plan 3a — `apps/voter` | **COMPLETE.** 6 tasks. voter 60/60 + 1 Playwright smoke. Preact, mobile-first |
| Plan 3b — `apps/admin` | **COMPLETE.** 6 tasks. admin 65/65. React 19, door as its own chunk |
| Legacy code | `backend/`, `admin-frontend/`, `voter-frontend/` still present. `backend/irv.py` MUST remain until the differential test is retired |
| Execution ledger | `.superpowers/sdd/<plan>/progress.md`, one per plan (gitignored, on disk only) |

**Verify state on resume:**
```bash
npm test                                  # core 142, admin 65, api 399, voter 60
npm run typecheck                         # all four clean
npm run e2e                               # 1 Playwright smoke (needs: npx playwright install chromium)
```

`npm test` deliberately does **not** run the e2e suite — it needs a browser binary, and the default
suite must never depend on one. The e2e workspace's script is therefore called `e2e`, not `test`;
renaming it back silently pulls Playwright into every run.

`npm run -w @election/api typecheck` works too, but note it resolves `tsconfig.json` relative to the
workspace directory, so run it from `apps/api` if you invoke `tsc` by hand. Do not trust the commit
count as a state check — it moves with every docs commit.

---

## 2. The data model after Plans 2b and 2c — READ BEFORE PLAN 3

Three migrations now. `0001_initial.sql` is applied to production and immutable; `0002` and `0003`
were added by 2b and 2c and are equally immutable from here.

### `0002` — `vote_receipt.live_receipt_hash`, and why it is normally NULL

Plan 2b needed it because `ballot` carries no voter reference — that absence *is* the secret ballot —
so a void keyed on `receipt_hash` alone cannot find the mark-off row to clear. The cost, accepted
deliberately by the user after being shown it: **while a ballot is live, this column joins a `usu_id`
to that ballot's preferences**, which is the correlation spec §2 drops `cast_at` and ROWID to prevent.

**That exposure is now bounded, and the bound is tested.** It is cleared when the ballot is voided,
and cleared for the whole election inside the same transaction that writes `election_seal`
(`routes/close.ts`). After close, no row holds a link — asserted in `tests/close.test.ts` and again
over a finished election in `tests/privacy.test.ts`. **Anything that reopens voting, or writes this
column outside a live ballot, breaks the guarantee.** Never select it into a response, an export or a
log line.

What the design buys: because the receipt row is found *through* the hash, a void always clears the
**true owner's** mark-off. A stolen token disenfranchises its owner — which spec §5's public void
endpoint already accepts — but cannot mint a second live ballot.

### `0003` — `election_result.quota`

Quota is not recoverable from anything `0001` stores (`Round` does not carry it, and the seal's
`ballot_count` includes voided ballots while the count excludes them), and the result endpoint serves
a second request from the stored row, so without it two GETs would differ.

### `0004` — guests, and members the export missed

Two door actions that must stay separate (`docs/superpowers/specs/2026-09-21-frontends-design.md` §0):

- **A guest attends and cannot vote.** `guest` has **no `usu_id`**, so the ballot insert's
  eligibility clause has nothing to match. That absence *is* the control — **never add a `usu_id` to
  that table** and never resolve a guest into `voter_roll`.
- **A member the export missed can vote**, as a `voter_roll` row with `added_at_door = 1`. This means a
  door password can enrol a voter, so the flag is a provenance control and **must never be cleared**:
  it is reported by `GET /quorum` and is a column in both attendance exports. The roll import's upsert
  must not mention it in its `SET` list.
- **The purge covers `guest`.** A guest's name is personal data and nothing else reaches that table.

### What the frontends settled (Plans 3a, 3b)

1. **No `.tsx` file contains a `style` attribute or a utility class.** This one rule is what makes the
   styling upgradable — restyling either app touches CSS only. The legacy apps cannot be restyled
   without editing JSX, because their styling *is* JSX. Grep for `style=` in `apps/*/src` to check.
2. **`packages/styles` is the whole design system:** `tokens.css` (values, plus a dark-mode block) and
   `base.css` (element defaults). `--touch: 44px` and the 16px input floor live there because they are
   mobile *constraints*, not preferences — iOS Safari zooms the viewport for a smaller input.
3. **Both apps' screens are lazy, and the entry chunk contains neither side's code.** Making only the
   door lazy is not enough: it leaves the officer screens in the entry chunk that every route loads.
   `apps/admin/tests/codeSplit.test.ts` guards this, because a single static import undoes it with
   nothing failing.
4. **The API clients are duplicated between the two apps, deliberately.** They overlap on one endpoint
   out of thirty-three; sharing would couple two release cycles to save thirty lines.
5. **Reordering a ballot is arrows, never drag**, and the boundary arrows are disabled rather than
   hidden so a row does not reflow under a moving thumb.
6. **The door roll is never written to browser storage**, and a test asserts no storage write happens
   at all rather than inspecting `localStorage` (which in the test environment is a locked proxy).
7. **There is no seeding endpoint in `apps/api` and there must never be one.** `e2e/seed.ts` provisions
   through documented endpoints with the dev super-admin key.

### What Plan 2c settled that Plan 3 must not undo

1. **`resolved_id`, not `winner_id`.** For an exclusion tie the id is the candidate **excluded**. A
   UI labelled "pick the winner" collects the opposite of the officer's intent and the result looks
   correct. The API echoes each tie's `kind`; **label the control from `kind`, never from a guess.**
   Spec §5 and §3 both say so now.
2. **Turnout is three integers**, and it is the only thing an officer sees while voting is open. A
   per-candidate figure there reopens what closing exists to control. `tests/turnout.test.ts` asserts
   the key set at both `open` and `closed`.
3. **`vote_receipt.usu_id` survives the purge, deliberately.** Spec §2's retention paragraph used to
   claim `voter_roll` and `check_in` were all the personal data; it now names the exception and says
   what is kept (who voted, in which election, when, how many recasts — never how). If that ever
   changes, the attendance export and §2 change with it.
4. **The ballot CSV carries `voided`, so the seal is reproducible from the export.** `toBallotsCsv`
   takes it as a required field on purpose: an omitted one would write `0` for a voided ballot and
   produce a digest that silently disagrees with the seal. `recount` still does not verify the digest
   itself — the check is available to an auditor, not performed for them.
5. **`tests/privacy.test.ts` runs the whole system and inventories every audited action.** A new
   audited action **fails that test**. That is the mechanism, not a nuisance: it forces the
   "never a usu_id, never a ballot id, never a preference list" decision to be made explicitly.
   **But it only sees routes its scenario calls.** Twice now (2c, then 2d) new actions passed silently
   because `runWholeElection` never reached them. **Extending that scenario is part of adding an
   audited action.**

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

## 6. Process lesson — now proven three times

The first Critical was in the **plan**, transcribed faithfully. Every per-task review compared code to
plan, and the code matched. **Nothing compared plan to spec.** So: a plan-vs-spec check *before*
execution, not only code-vs-plan during it.

It has since paid for itself twice more. In **2b** it found that Task 7's void could not be
implemented at all as written (no possible `WHERE` clause) and that Tasks 6 and 7 contradicted each
other. In **2c** it found four things: the seal did not clear `live_receipt_hash`, `quota` had nowhere
to be stored, spec §2's retention claim was false, and **two spec §5 routes appeared in no plan at
all** — while 2c's closing line claimed `apps/api` would be complete against §5.

The lesson has a sharper edge than "check the plan": **a plan written before its dependency executed
cannot know what that dependency added.** 2c was written before 2b ran, so it could not have known
`live_receipt_hash` existed. Re-read the spec *and* the previous plan's outcome before executing a
plan that was written in advance.

---

## 7. Forward constraints Plan 2 had to honour — all discharged, kept for the reasoning

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
6. ~~**The ballot export carries no `voided` column**~~ — **CLOSED by 2c Task 4.** Both predicted
   breakages were real: `recount` rejected the wider file on field count, and it had no notion of a
   voided ballot. Both fixed in `packages/core`, and spec §2 now states that the seal *is*
   reproducible from the export. See §2.4 above for what remains true (recount does not itself verify
   the digest).
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
count, recount, toBallotsCsv, toCandidatesCsv, ExportBallot
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

- `well-written-code-karpathy.md` at the repo root is a working guideline the user asked to be
  followed (2026-09-21). The rules that actually bite on this codebase: read the file before changing
  it, keep the diff to the task, TDD with the failing test actually watched, no abstraction before the
  third copy, no new dependencies, and investigate a failure rather than guessing at it.

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
- Plan 2c: `.superpowers/sdd/2026-09-21-api-result-path/progress.md` — the four gaps the check found,
  the retention decision, and a debugging note on a failure that read as a test-runner bug and was not
- Plan 2d: `.superpowers/sdd/2026-09-21-api-guests-and-door-additions/progress.md`
- Plans 3a/3b: `.superpowers/sdd/2026-09-21-frontends/progress.md` — including the code split that did
  not do what it claimed, and two rule violations only a whole-repo run exposed

All six are gitignored. This file is the committed summary; the ledgers hold the detail.
