# Accepted limitations

Every limitation in this system that was **decided rather than overlooked**. One list, so that
"what are the known limitations?" has a single answer, and so that nobody rediscovers one of these
as if it were a bug and quietly "fixes" it into something worse.

Each entry says what the limitation is, why it was accepted, and what would close it. A limitation
leaving this list should mean it was closed, not that it was forgotten.

**Last updated:** 2026-09-24, after moving rate limits off KV (18 live entries, 1 closed).

---

## 1. A lost submit response costs the voter their receipt — permanently

**Where:** `apps/voter` (Plan 3), consequence of `apps/api/src/routes/ballots.ts`.

The receipt token is minted at submission, hashed, and **never stored server-side** — only
`sha256(token)` is kept, which is what stops the receipt being used to prove how someone voted. So
if the ballot insert commits but the HTTP response is lost (a phone dropping off wifi at exactly the
wrong moment), the ballot is recorded and that voter can never retrieve their receipt. A retry
returns `409 already_voted`, which is truthful but indistinguishable from "you voted earlier".

**Why accepted:** the alternative is storing the token, which would let anyone holding the database
resolve a receipt to a ballot — the exact capability the hash exists to remove. A recoverable
receipt and a secret ballot are in direct tension, and the secret ballot wins.

**What the UI must therefore do:** say it plainly — *"Your vote was recorded. We couldn't show you a
receipt, so you won't be able to verify it later."* Never imply the vote failed, and never offer a
retry that would read as a second chance at the receipt.

**What would close it:** nothing, while receipts stay unstored. The only real mitigation is reducing
the window (submit on a stable connection, keep the request small), not eliminating it.

## 2. `recount` does not verify the seal; it only lets you verify it

**Where:** `packages/core/src/recount.ts`.

Since 2026-09-21 the exported ballot CSV carries `voided`, so `ballots_sha256` **is** recomputable
from the export. But `recount` still takes `ballotsSha256` as a parameter and uses it solely to seed
tie-break draws. It does not recompute the digest and does not refuse a mismatch.

**Why accepted:** the check belongs to the auditor, who should compute it themselves rather than
trust the tool that is also doing the counting. Told the other way: a `recount` that verified its own
input would be attesting to its own honesty.

**What would close it:** an optional strict mode that recomputes and refuses a mismatch. Cheap; not
yet needed, because the officer-facing story is "here is the file, here is the digest, check it".

## 3. No known-answer corpus for multi-seat counts

**Where:** `packages/core` verification strategy. Also HANDOFF §5.

Verification rests on 200 randomised property elections plus a differential against the legacy
`irv.py` at `seats = 1` only — so **no surplus-transfer code is compared against a published
result**. The property tests assert invariants; a wrong count that satisfies all of them passes, and
this is not hypothetical: two genuine multi-seat defects passed all 200.

**Why accepted:** temporarily, and only because no multi-seat election has been run on this system.

**What would close it:** enter two published multi-seat counts as fixtures — Scottish council ward
results publish full round-by-round transfer tables, and the AEC publishes worked Senate examples.
Estimated an afternoon. **Do this before any `seats >= 2` election runs.** This is the most
consequential item on this list.

## 4. `vote_receipt.usu_id` survives the post-AGM purge

**Where:** `apps/api/src/routes/purge.ts`, spec §2 retention.

`voter_roll` and `check_in` are deleted; `vote_receipt` is kept, and it records which member voted in
which election, when, and how many times they recast.

**Why accepted (2026-09-21):** the mark-off is half the integrity story — it is what shows that N
distinct eligible members cast the N ballots in the box, and the attendance export is built from it.
Deleting integrity evidence to make a retention sentence true is the worse trade. Spec §2 now names
the exception rather than claiming otherwise. Nothing joins it to a ballot after close.

**What would close it:** a second, later purge of `vote_receipt` once the result can no longer be
disputed — a retention period rather than a retention rule. Needs a governance decision, not code.

## 5. IGM can inflate a ballot's transfer value

**Where:** `packages/core/src/count.ts`, spec §3.

Inclusive Gregory divides a surplus by the *number* of papers, so a paper that arrived at 0.1667 can
transfer onward at 0.25. This is a real, documented defect of the method.

**Why accepted:** it is what the Australian Senate does, and one transfer value per distribution is
hand-checkable by a scrutineer against a printed round table. WIGM is more precise and needs papers
sorted by incoming weight with a figure per group. Changing an outcome requires multi-seat contests,
stacked transfers *and* large numbers — it was material in a 1.3-million-vote Senate count, not
typically in a room of two hundred.

**What would close it:** WIGM, at the cost of hand-checkability. Not recommended.

## 6. Per-IP rate limiting is weak by design, and cannot be tightened

**Where:** `apps/api/src/middleware/rateLimit.ts`.

An AGM is one room on one wifi network, and Australian carriers use CGNAT, so a single IP can be the
entire electorate. Voting surfaces therefore allow 600 per minute per IP, which will not stop a
determined attacker. The limiter fails open: if it errors, requests go through.

**Why accepted:** a limit tight enough to stop an attacker locks out the room, which breaks the
election outright. Integrity comes from the roll, the door check-in and the `vote_receipt` primary
key. The limits exist to bound billable CPU and to stop the audit trail being flooded — not to be a
quota. The fixed window also admits up to 2x the limit across a boundary, accepted for the same
reason.

**What would close it:** nothing at this layer. Per-session or per-member limits would be tighter,
but the controls that actually protect the count are elsewhere.

## 7. `vote_receipt.live_receipt_hash` joins a voter to their ballot while voting is open

**Where:** migration `0002`, `apps/api/src/routes/ballots.ts`, `routes/close.ts`.

While a ballot is live, this column links a `usu_id` to that ballot's preferences — the correlation
spec §2 drops `cast_at` and ROWID to prevent. Anyone with database access during voting can follow it.

**Why accepted:** `ballot` carries no voter reference, so without it a void cannot find the mark-off
to clear, and spec §4's "voiding lets the voter cast again" is unimplementable. The alternative
considered was a MAC-binding the token to the voter with no stored link; this was chosen for
simplicity, and it turned out to be safer against a stolen token (the mark-off cleared is always the
true owner's).

**Bounded, and the bound is tested:** cleared on void, and cleared for the whole election in the same
transaction that writes `election_seal`. **Anything that reopens voting, or writes this column
outside a live ballot, breaks the guarantee.**

## 8. Authentication cannot be tested on preview URLs

**Where:** spec §1's hard deployment precondition.

`SameSite` is judged by registrable domain, so all three deploys must sit on one apex. On
`*.workers.dev`, `*.pages.dev` or `*.vercel.app` the cookie is never sent and **every authenticated
request fails with nothing that points at the cause** — indistinguishable from a CORS
misconfiguration, which is what makes the tempting fix (`origin: '*'`) reinstate a closed hole.

**Why accepted:** it is a property of how browsers scope cookies, not a choice.

**Mitigation:** Plan 3's single Playwright smoke test drives a real browser against the API on
localhost, where all three share an origin — the one place jsdom cannot help and the failure is
catchable before an AGM.

## 9. `audit_log` cannot be purged, so nothing personal may ever enter it

**Where:** `apps/api/src/db/audit.ts`.

Spec §2 gives `election_seal` and `election_result` no `ON DELETE CASCADE`, so a sealed election —
and therefore its batch — cannot be removed, and neither can its audit rows.

**Why accepted:** an audit trail that cascades away with its subject is not an audit trail.

**The obligation it creates:** `AuditEntry.detail` is an allow-list, and the rule is **never a
usu_id, never a ballot id, never a preference list**. `tests/privacy.test.ts` inventories every
audited action and **fails when a new one appears**, which is the mechanism that forces the decision.

## 10. The door app's roll is lost on reload

**Where:** `apps/admin` door route (Plan 3).

The roll is held in memory only, so a dropped connection mid-queue is survived but a page reload
needs the network again.

**Why accepted (2026-09-21):** the alternative is 1,300 members' names and USU ids in browser storage
on a volunteer's personal device, outside the reach of the purge — which would narrow the retention
claim to something much less defensible. The door session's TTL is an hour anyway, so a reload
frequently means re-authenticating regardless.

## ~~11. The door cannot enrol a member the export missed~~ — CLOSED, 2026-09-21

Recorded and closed the same day. It was accepted for a few hours on the reasoning that a door which
can create voters would mean one door password could manufacture an electorate. The user then asked
for that flow explicitly, and it was built in Plan 2d **with the controls this entry named as the
condition for reopening it** — a distinct flag, and the count of door-added voters stated wherever the
total is. `POST /api/batches/:id/voters` creates the member and checks them in; they can sign in and
vote immediately.

Kept here rather than deleted, because the reasoning is the condition on which it stays closed. See
item 12 for what replaced it.

## 12. A door password can enrol a voter

**Where:** `apps/api/src/routes/doorVoters.ts`, migration `0004`.

"Eligibility derives from the USU membership export" is now "…derives from the export, plus N people
the returning officer's door staff added". Anyone holding the door password can create an eligible
voter, and the door password is typed on volunteers' phones in a public room.

**Why accepted (2026-09-21, by the user, having been shown this cost):** the alternative is turning
away a member who has paid, because the CSV was exported before they joined. That is worse. A member
standing at the desk with proof of membership is the common case; an attacker with the door password
is the rare one, and they are bounded by needing to be in the room with a door session.

**What keeps the total defensible, and must not be removed:**

- `voter_roll.added_at_door` flags every such row and is **never cleared** — a later corrected export
  refreshes the name and eligibility and leaves the flag alone.
- `GET /quorum` reports `added_at_door` beside the totals, so the number is never shown without it.
- **Both attendance exports carry it as a column**, so a committee reading the file sees which voters
  came from the export and which did not. This is the control that matters most: it is the one a
  scrutineer can check without trusting us.
- The endpoint refuses a `usu_id` already on the roll rather than upserting, so a mistyped id cannot
  overwrite a real member's name in the table eligibility is judged from.
- A door-added member cannot be removed once they have voted, and a member from the export cannot be
  removed at the door at all.

**What would narrow it:** requiring an officer session rather than a door session for this one action,
which trades a volunteer's autonomy at the desk for a stronger claim. Worth revisiting if a real AGM
shows the door rarely needs it.

## 13. `recount()` has no command-line wrapper

**Where:** `packages/core/src/recount.ts`.

The offline recount is a library function with no caller outside its own tests. "Recompute the count
in front of whoever is disputing it" therefore means someone writing a few lines of TypeScript on the
day, against two CSV files.

**Why accepted:** the function, its format and its refusals are the hard part and they are done and
tested. A wrapper is half an hour's work whenever it is actually wanted, and guessing its interface
now — file paths? stdin? a flag for the digest? — would be inventing requirements.

**What would close it:** a small `packages/core/bin/recount.ts` taking the two CSV paths, the seat
count, the election id and the sealed digest, printing the round table. Worth doing before an AGM
where a dispute is likely, not before one where it is not.

## 14. A registered society is unverified, and cannot be verified

**Where:** `apps/api/src/routes/batches.ts`, `apps/admin/src/screens/SignUp.tsx`, spec §5a.

Signup is open: anyone can register a society with any name. Nothing confirms they are who they say
they are, and nothing can — the system sends no email, so there is no channel to confirm through.

**Why accepted (2026-09-22, at the user's direction):** the alternative, in practice, was that no
interface existed at all and creating a society meant hand-crafting an HTTP request with a secret
header. An election tool nobody can start is worse than one that starts unverified.

**What bounds the damage:**

- A new society has an empty roll. It can only enfranchise members it imports, and it can never reach
  another society's members, elections, ballots or results.
- Reserved slugs prevent `admin`, `api`, `official` and similar.
- Both frontends state that the society list is not an endorsement.
- The audit trail records whether each society was self-registered (`role: 'public'`) or created by
  the operator with the key (`role: 'super'`).

**What would close it:** a verification channel — an email confirmation, or approval by the operator
before a society may open its first election. The second is the cheaper one and needs no new
infrastructure: a flag on `batch`, set by an operator-only route, checked at `POST /elections/:eid/open`.
Worth doing if impersonation ever actually happens.

## 15. A held receipt token is a capability to void that ballot

**Where:** `apps/voter/src/receipts.ts`, `apps/api/src/routes/receipts.ts`, spec §4 and §5.

The receipt token is written to `localStorage` under `election:receipts:<batchId>`, and
`POST /api/receipts/:token/void` is public. So anyone who can read that storage — someone borrowing
the phone, a shared or kiosk device, an XSS in the voter app — can void that ballot for as long as the
election is open.

**Why accepted (2026-09-22):** spec §4 requires storing it, and the reason is stronger than the risk.
The token is shown once and is never stored server-side: a voter who reloads the page without it has
permanently lost the ability to verify their own ballot, which is limitation 1 arriving by a second
route. Voting is on a voter's own phone by design, and the same person holding the phone could vote
again from the receipt on screen anyway.

**What bounds the damage:**

- Voiding does not cast. The recast has to come back through the voter's own session, because the
  mark-off cleared is always found *through* the hash and so is always the true owner's.
- It stops working the moment the election closes: both statements in the void transaction carry the
  open-election test.
- Every void is written to `audit_log` as `ballot.void`, attributed to the owning batch. A run of them
  is visible to an officer.
- The token proves inclusion only. It never reveals preferences, so it is useless to a coercer.

**What would close it:** requiring the voter's session cookie on the void route, and scoping the
lookup to that voter's own live receipt. That is a real improvement and cheap; it was not done here
only because the void route being public is spec §5's stated design, and changing it is an API change
rather than a frontend one.

## 16. The voter app can never tell a voter they are finished

**Where:** `apps/voter/src/screens/Agenda.tsx`, spec §4.1.

A voter is shown what is open now and told to keep the page open. They are never told the voting is
over, because the app cannot know: a `draft` election is invisible to a voter by design (spec §6), so
"nothing is open" is indistinguishable from "nothing is open yet". A voter who closes the tab after the
last item still gets no confirmation that they voted in everything.

**Why accepted (2026-09-22, after the flow was found wrong in use):** the alternative was worse and had
already shipped. The app used to snapshot the open list at page load and, on reaching the end of it,
say "That is every election. Thank you for voting." — during an AGM that opens its elections one at a
time, that told voters the meeting was finished after the first item. A screen that under-claims costs
a voter a little uncertainty; one that over-claims costs them the rest of their votes.

**What would close it:** the officer telling the app the agenda is done — a batch-level "voting
complete" flag, set explicitly, which the voter app could show as a genuine end. It has to be an
officer action rather than anything inferred, because "no election is currently open" is the normal
state between two agenda items.

## 17. Deleting a society destroys evidence, and one key is all it takes

**Where:** `DELETE /api/batches/:id` in `apps/api/src/routes/batches.ts`, `apps/admin/src/screens/Operator.tsx`.

The operator can delete a society outright, including closed elections, their ballots, their
`election_seal` rows and their `election_result` rows. Nothing inside the system can undo it, and
nothing inside the system keeps a copy. `SUPER_ADMIN_KEY` plus the society's slug is the whole
authorisation: there is no second operator, no approval step and no delay.

Note what this changes: spec §2 gave `election_seal` and `election_result` no `ON DELETE CASCADE` so
that a sealed result could never be removed *incidentally*, and until 2026-09-22 the comment on
`AuditDetail` said a batch could not be removed at all. That protection against accident is intact —
nothing cascades into those tables, and the officer-facing delete refuses the moment a ballot exists —
but deliberate destruction by the operator is now possible where before it was not.

**Why accepted (2026-09-22, at the user's direction):** a service that cannot remove a tenant is a
service that accumulates other people's personal data with no way to honour a request to delete it,
and in practice the operator already holds the database. The realistic failure was never a malicious
operator; it was a pile of abandoned test societies on the public list, which is what prompted this.

**What bounds the damage:**

- The key is compared in constant time, the route is rate-limited before the check, and a denied
  attempt is recorded as `batch.delete.denied` against a NULL batch.
- `confirm_slug` must match, so deleting the wrong society takes more than a mis-pasted id.
- `audit_log` survives — it is the one table with no foreign key to `batch` — and records the deletion
  as counts of what was destroyed. A society whose records are gone still has the trail saying they
  existed and when they went.
- The admin screen is not linked from anywhere, and the key it takes is never stored.
- The officer role cannot reach any of this. An officer password can delete an election only while no
  ballot exists in it.

**What would close it:** a soft delete — a `deleted_at` column, hidden everywhere, purged by a
scheduled job after a grace period — which would turn an irreversible action into a recoverable one
and still take abandoned societies off the list. That is the right shape if this is ever used on a
society that has really run an election. A second operator approval, or an export-before-delete
requirement, would cost more than it buys at this scale.

---

## 18. Passwords are hashed at 100,000 PBKDF2 iterations, under OWASP's 210,000

**Where:** `apps/api/src/auth/password.ts`, and `DUMMY_HASH` in `apps/api/src/routes/auth.ts`.

Production Workers throw `NotSupportedError: Pbkdf2 failed: iteration counts above 100000 are not
supported`. Local workerd has no such limit, so at 210,000 the test suite and `wrangler dev` were all
green while every society sign-up on `api.dalyell.com.au` returned 500.

**Why accepted (2026-09-23):** it is the platform ceiling, not a choice. The only alternatives are
Argon2 or bcrypt as WASM, which cost bundle size and CPU time on every sign-in. Against a leaked hash
of a six-character password (see the note in `routes/batches.ts`), the difference between 100k and
210k iterations is about 2x, which is not where the defence comes from. The sign-in rate limit is.

**What bounds it:** `tests/password.test.ts` fails if the count goes above 100,000 again, and the
stored hash carries its own count, so raising it later needs no migration.

**What would close it:** Cloudflare raising the ceiling, or a WASM Argon2id build if the CPU cost
proves affordable.

---

## 19. Rate limits fail open, and are approximate

**Where:** `apps/api/src/middleware/rateLimit.ts`, `ratelimits` in `apps/api/wrangler.jsonc`.

Limits used to be counters in KV. On 2026-09-24 the free plan's 1,000 KV writes a day ran out, `put()`
threw, and every limited route returned 500, including voter sign-in and ballot submission. They now
use the Workers Rate Limiting binding, which has no storage quota. If that binding errors, the request
is **allowed** and the error is logged. Its counters are per Cloudflare location and eventually
consistent, so it can admit somewhat more than the configured limit, and the only periods it offers
are 10 or 60 seconds.

**Why accepted:** the limits were always cost ceilings, not integrity controls (§5). A limiter that
fails closed turns its own outage into an election outage, which is what happened. The one place a
limit matters for security is staff sign-in with six-character passwords (§18). There a limiter
outage briefly removes the throttle, but PBKDF2 and the audit row still apply.

**What would close it:** a Durable Object counter would be exact and would not depend on a
per-location binding, but it adds a moving part to every voting request for no integrity gain.
