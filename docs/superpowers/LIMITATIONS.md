# Accepted limitations

Every limitation in this system that was **decided rather than overlooked**. One list, so that
"what are the known limitations?" has a single answer, and so that nobody rediscovers one of these
as if it were a bug and quietly "fixes" it into something worse.

Each entry says what the limitation is, why it was accepted, and what would close it. A limitation
leaving this list should mean it was closed, not that it was forgotten.

**Last updated:** 2026-09-21, after Plan 2d (11 live entries, 1 closed).

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
entire electorate. Voting surfaces therefore allow 300 per 10 minutes, which will not stop a
determined attacker.

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
