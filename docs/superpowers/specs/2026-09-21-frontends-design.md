# election-code frontends — design

**Date:** 2026-09-21
**Status:** approved, ready for implementation planning
**Covers:** `apps/voter`, `apps/admin` (including the door route), `packages/styles`, `e2e/`, and one
prerequisite API addition (§0 — guest attendance)
**Depends on:** `apps/api` complete against spec §5 (359 tests), `packages/core` (142 tests)
**Parent spec:** `docs/superpowers/specs/2026-09-16-election-code-rewrite-design.md`

## Purpose

Replace the two legacy React apps with frontends that can actually run an AGM from a phone, and
whose styling can be upgraded later without editing a single component.

The legacy apps are 1,002 lines of JSX with 17 inline `style={{…}}` objects, one `--accent` CSS
variable, and no stylesheet. Two things make them unfit rather than merely dated:

1. **The ballot is checkboxes whose rank comes from click order.** `toggleRank` appends to an array,
   no ordinal is ever shown, and changing preference 2 means unticking everything after it. Spec §4
   requires this rebuilt, not ported.
2. **They are built for a desktop.** Most votes will be cast on a phone in a room, so the phone is
   the primary target and the desktop is the easy case — not the other way round.

## Non-goals

- No visual redesign beyond a coherent minimum. The point of the token layer is that a designer can
  arrive later and never touch a `.tsx` file.
- No component library, no CSS framework, no state-management library, no `axios`.
- No offline voting. Voters are present and checked in; the network is assumed, and only the door
  search is expected to survive losing it.
- No fourth deploy. The door UI is a route of the admin app (see §5.3).

---

## 0. Prerequisite API work: guests, and members the export missed

**This must ship before the door UI can use it, and it is not frontend work.** It is listed here
because the requirement surfaced during this design, and because the door screen in §5.3 depends on it.

### 0.1 Why it needs the API at all

A guest is currently **impossible by construction**. `check_in` carries a foreign key onto
`voter_roll(batch_id, usu_id)`, and the insert is guarded by
`WHERE EXISTS (SELECT 1 FROM voter_roll WHERE … AND eligible = 1)`. Ballot submission re-checks the
same join inside its transaction. There is no way to record someone who is not on the roll, by design.

### 0.2 Two separate actions, deliberately not one

The door gets **two buttons**, because two different people turn up and conflating them would let a
volunteer grant a vote by accident:

| Action | Who it is for | Can vote |
| --- | --- | --- |
| **Add guest** | an observer, partner organisation, staff, a member's guest | **No** |
| **Add member** | someone genuinely eligible whom the export missed — they joined last week | **Yes** |

One catch-all button would mean the volunteer's finger decides whether a stranger gets a ballot. Two
buttons, worded differently, with different fields and different confirmations, make that a decision
rather than a side effect.

**What "add member" costs, stated plainly.** It means a door password can enrol a voter, so the claim
"eligibility derives from the USU membership export" becomes "…derives from the export, plus N people
the returning officer's door staff added". That is a real weakening, and it is accepted because the
alternative — turning away a member who has paid — is worse. What makes it defensible is that the N is
never hidden:

- **`voter_roll.added_at_door`** flags every such row, permanently.
- **Both attendance exports carry the flag as a column**, so a committee reading the file sees which
  voters came from the export and which did not.
- **`GET /quorum` reports `added_at_door` beside the totals**, so the number is never presented
  without it.
- The flag is **sticky across a re-import**: if a corrected export later contains that member, the
  upsert refreshes their name and eligibility but does not clear the flag. A human created that row at
  the door, and a later file cannot un-happen it.

**A guest, by contrast, has no `usu_id` at all.** Nothing joins a guest to the roll, so a guest cannot
satisfy the ballot insert's eligibility clause — they cannot vote because the query has nothing to
match, not because a check says no.

### 0.3 Schema — migration `0004_guests_and_door_additions.sql`

Guests get their own table rather than a flag on `voter_roll`: mixing rows that are not members into
the roll would corrupt what the roll means, what the import's upsert does on re-import, and what
"1,298 eligible" counts. A door-added *member* is the opposite case — they genuinely belong on the
roll — so they are a roll row with a flag.

```sql
CREATE TABLE guest (
  id            TEXT PRIMARY KEY,     -- crypto.randomUUID()
  batch_id      TEXT NOT NULL REFERENCES batch(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,        -- as the volunteer typed it
  note          TEXT,                 -- optional: "observer, USU exec"
  checked_in_at INTEGER NOT NULL
);

-- A roll row a human created at the door, not one the export produced. Never
-- cleared: a later corrected export refreshes the name and eligibility, and the
-- fact that someone typed this row in at a desk stays true.
ALTER TABLE voter_roll ADD COLUMN added_at_door INTEGER NOT NULL DEFAULT 0;
```

### 0.4 Endpoints

```
POST   /api/batches/:id/guests            {name, note?}              -> 201   door role
GET    /api/batches/:id/guests                                               door role
DELETE /api/batches/:id/guests/:guestId                              -> 204   door role
POST   /api/batches/:id/voters            {usu_id, first_name, last_name} -> 201  door role
DELETE /api/batches/:id/voters/:usuId                                -> 204   door role
GET    /api/batches/:id/quorum  -> {checked_in, eligible, guests, added_at_door}  door role
GET    /api/batches/:id/guests.csv                                           officer role
```

**`POST /voters` creates the roll row and the check-in in one transaction**, because the volunteer's
intent is "this person is here and needs to vote", and a roll row without a check-in is a member who
still cannot vote.

**It refuses a `usu_id` already on the roll, with 409** — it is not an upsert. A mistyped id that
happens to match a real member would otherwise overwrite that member's name with the typed one. If
they are already on the roll, the correct action is to search for them and check them in, which is
what the 409 tells the volunteer to do.

**`DELETE /voters/:usuId` undoes a mistyped entry**, and only that: it refuses unless
`added_at_door = 1` (never a member from the export) **and** that member has cast no ballot in this
batch (no `vote_receipt` row). Deleting a roll row for someone who has voted would destroy the
eligibility evidence behind a ballot that is already in the box.

**A door-added member counts in `eligible` and `checked_in` like any other**, because they are a
member. `added_at_door` is reported beside those numbers so the total is never shown without its
provenance.

- **`GET /quorum` gains `guests` as a third number and the existing two are unchanged.** Quorum is
  `checked_in / eligible` against the roll (spec §4); a guest must never move that ratio. They are a
  separate head-count reported beside it.
- **`DELETE` exists because the commonest guest error is a mistaken tap**, and a volunteer must be
  able to undo it without an officer.
- **`guests.csv`** is its own export — `name,note,checked_in_at` — rather than rows in
  `attendance.csv`, which is the `vote_receipt` mark-off and therefore about voting. A guest did not
  vote, and putting them in that file would misrepresent both.

**One existing test changes, expectedly.** `apps/api/tests/checkIn.test.ts:120` asserts the quorum
body with `toEqual({ checked_in: 2, eligible: 4 })`, so a third key fails it. That is the assertion
doing its job — it pins the response shape — and updating it is part of Plan 2d, not a regression to
work around.

### 0.5 Three obligations this creates

1. **A guest's name is personal data, so the post-AGM purge must delete `guest`.** It goes in the same
   transaction as `check_in` and `voter_roll`, the return value gains a `guest` count, and spec §2's
   retention paragraph must name it. Getting this wrong recreates exactly the false retention claim
   that was corrected on 2026-09-21.
2. **Every new audited action carries no detail at all.** `guest.add`, `guest.remove`,
   `voter.add_at_door` and `voter.remove_at_door` record the action and the batch, never the name and
   never the usu_id — the name *is* the whole payload, and `audit_log` cannot be purged. The
   accountability for a door-added voter lives in `voter_roll.added_at_door` and the attendance
   exports, which the purge can reach; the audit log records only that it happened. This adds four
   entries to the action inventory in `apps/api/tests/privacy.test.ts`, the test designed to fail when
   a new audited action appears.
3. **Both attendance exports gain an `added_at_door` column.** This is the control that makes the
   weakening in §0.2 survivable: a committee reading the file can see which voters came from the
   membership export and which were added at a desk. Never present the total without it.

### 0.6 Tests

Guests: added, listed and removed by the door role and nobody else; a guest **cannot be checked in as
a voter and cannot sign in to vote**; `quorum` reports guests without moving `checked_in` or
`eligible`; the purge deletes them; no `audit_log` row carries a guest's name.

Door-added members: created with a check-in in one transaction; **can then sign in and cast a ballot**
(the test that proves the feature works at all); refused when the `usu_id` is already on the roll, with
the existing member's name left untouched; removable while they have not voted and refused once they
have; flagged in `quorum` and in both attendance exports; and the flag survives a re-import that
includes them.

---

## 1. Architecture

```
packages/
  core/          unchanged — count, validateBallot, domain types
  styles/        NEW — tokens.css + base.css. Two files, no JS, no build step.
apps/
  api/           unchanged
  voter/         Preact via React alias, Vite 7, TypeScript   -> vote.dalyell.com.au
  admin/         React 19, Vite 7, TypeScript                 -> admin.dalyell.com.au
e2e/             NEW — one Playwright smoke test
```

Three deploys, as spec §1 requires. The door UI does not add a fourth.

### 1.1 What is shared, and what deliberately is not

**Shared: `packages/styles`.** The two apps must not drift visually, and this is the layer being
upgraded later — so it is one place, not two.

**Not shared: the API client.** The voter app calls 5 endpoints, the admin app calls 28, and they
share exactly one (`GET /api/batches/by-slug/:slug`). A shared client would couple two apps to buy
one function. Each app owns a small `src/api.ts` over `fetch`.

**Shared by import: `@election/core`'s types.** `Candidate`, `Round`, `RoundCount`,
`TieBreakRecord`, `CountResult` and `TieBreakKind` are already exported and dependency-free. The
admin result screen renders the same types the count produced, so a change to the counting library's
output shape becomes a type error rather than a silently wrong table.

`minimumPreferences` and `validateBallot` are also imported by the voter app, so the client-side
check and the server-side check are the same function rather than two implementations that can
disagree about what a valid ballot is.

### 1.2 Dependencies, in full

| Package | Where | Why |
| --- | --- | --- |
| `preact` | voter | Spec §1. Aliased to `react`/`react-dom` so the ecosystem and Testing Library work unchanged. |
| `react`, `react-dom` | admin | Spec §1. React 19. |
| `react-router` | admin only | ~10 routes and a lazy boundary earn a router. The voter app has three screens and gets a `switch`. |
| `vite`, `typescript` | both | Spec §1. |
| `vitest`, `@testing-library/*`, `jsdom` | both, dev | §7. |
| `@playwright/test` | `e2e/`, dev | One test, for the one failure jsdom cannot see. §7.2. |

Nothing else. No `axios` (the legacy dependency), no CSS framework, no component library, no state
library, no date library, no icon package.

### 1.3 Development, and the cookie trap

The API runs on `http://localhost:8787` (`wrangler dev`), the voter app on `:5173`, the admin app on
`:5174`. Both dev origins go in the API's `ALLOWED_ORIGINS`.

**Do not add a Vite dev proxy to make the apps same-origin in development.** It would work, and it
would hide the CORS path entirely until production. Dev should exercise the real credentialed
cross-origin request.

**Cookies are not port-scoped, so `localhost:5173` and `localhost:8787` share a cookie jar** and
`SameSite=Strict` is satisfied — the registrable domain is `localhost` either way. This is why spec
§1 says auth can be tested against localhost but not against preview URLs.

**Do not remove `Secure` from the session cookie to make development work.** Browsers treat
`localhost` as a secure context and will accept a `Secure` cookie over plain HTTP there. If sign-in
appears to work but every later request is unauthorised, the cause is an origin problem, not the
`Secure` flag — and dropping it would ship a session cookie that travels in clear text.

---

## 2. The styling system

Three layers, in order of how often they change:

```
packages/styles/tokens.css     values only          rebrand = edit this file alone
packages/styles/base.css       element defaults     type scale, focus, form controls, layout
apps/*/src/app.css             semantic classes     .ranked-item, .panel, .rounds-table
```

### 2.1 Tokens

```css
:root {
  /* colour */
  --accent: #2563eb;          /* overwritten per society at runtime, from the API */
  --accent-ink: #ffffff;      /* text on accent */
  --ink: #111111;
  --muted: #666666;
  --paper: #ffffff;
  --sunk: #f6f6f6;            /* panels, table stripes */
  --rule: #e5e5e5;
  --danger: #b00020;
  --ok: #1b5e20;

  /* space — one scale, used as calc(var(--step) * n) */
  --step: 0.5rem;

  /* type */
  --font: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  --font-figures: ui-monospace, SFMono-Regular, Menlo, monospace;

  /* shape and layout */
  --radius: 6px;
  --measure: 34rem;           /* one readable column */
  --touch: 44px;              /* minimum interactive target — see §2.3 */
}

@media (prefers-color-scheme: dark) {
  :root {
    --ink: #f2f2f2; --muted: #a0a0a0; --paper: #121212;
    --sunk: #1c1c1c; --rule: #2e2e2e; --danger: #ff6b6b; --ok: #7bd389;
  }
}
```

Dark mode is included now, not for its own sake but because it is the cheapest possible proof that
the token layer works: a component that hardcodes `#111` is invisible until something redefines the
token.

### 2.2 The rule that keeps the upgrade path open

**Markup carries semantic class names only. No utility classes, no inline `style` objects.**

This is the single constraint that makes "minimal now, upgraded later" true rather than aspirational.
The legacy apps cannot be restyled without editing JSX, because their styling *is* JSX. With this
rule, an upgrade — a designer's system, a component library, Tailwind if you want it — touches CSS
files and zero `.tsx` files.

One deliberate exception, inherited from the legacy app because it is correct: `branding.accent_color`
from the API is written to `--accent` on `:root` at load. Per-society colour, no per-society build.

### 2.3 Mobile rules, stated because they are easy to get wrong

Most votes will be cast on a phone. These are not preferences:

- **`min-height: var(--touch)` (44px) on every interactive element.** The controls that fail this by
  default are the small ones: the remove `✕` and the reorder `▲▼`.
- **No input font-size below 16px.** iOS Safari zooms the viewport when a focused input is smaller,
  which throws the layout and reads as a broken page. One rule in `base.css`.
- **`<meta name="viewport" content="width=device-width, initial-scale=1">` and no `maximum-scale`.**
  Locking zoom is the common reflex and it breaks pinch-to-zoom for anyone who needs it.
- **Primary actions at the bottom of the screen, sticky**, with `padding-bottom:
  env(safe-area-inset-bottom)` so the iPhone home bar does not sit on the submit button.
- **One column, `--measure` maximum, 16px side gutters, no horizontal scroll at 320px.**
- **`inputMode` set per field** — `numeric` for a USU id, so the number pad opens.

---

## 3. The API client contract

One `src/api.ts` per app, over `fetch`, with `credentials: 'include'` on every request (spec §1).
It maps the API's error contract to actions rather than to messages:

| Response | What the UI does |
| --- | --- |
| `401` | Re-show sign-in. **Never a dead end** — the door cookie's TTL is an hour and an AGM runs longer. |
| `403` + `code` | The specific remedy. `not_checked_in` → "see the door desk"; `ineligible` → "membership problem". |
| `409` | State the rule, not the failure: "voting has closed", "candidates are frozen once voting opens". |
| `429` + `retry_after` | "Too many attempts — try again in N minutes." |
| `5xx` | "Something went wrong at our end." Never the server's message. |

Every API failure is JSON, guaranteed by the API's `app.onError`, so no response needs a
`res.text()` fallback.

---

## 4. The voter app

### 4.1 Screens

```
/<slug>   sign in  ->  agenda (what is open now)  ->  ballot  ->  receipt
                            ^________________________|_________|
/<slug>/receipt        check a receipt token
```

No router. One `useState` for which screen is showing, and each screen carries the election it is
about rather than an index into a list.

**The agenda screen, and the polling behind it, are not cosmetic.** An AGM opens its elections one at
a time as the meeting reaches them, and only an `open` election is visible to a voter — a `draft` one
must stay hidden (spec §6). So the list of open elections is the list *for one agenda item*, and an
app that walks the list it loaded with and then reports completion tells a voter the meeting is over
when it has barely started. Two rules follow, and both are load-bearing:

1. **The open-election list is polled, every ten seconds, for as long as the page is open.** That is
   how the next agenda item reaches a voter who is holding their phone, and how the pre-sign-in wait
   turns into a sign-in form. A failed poll keeps the last good list — dropping to "nothing is open"
   because one request timed out is a lie a voter acts on by leaving.
2. **No screen may ever state or imply that voting is finished.** The app cannot know that: the
   elections still to come are invisible to it. The most it may say is that nothing is open *right
   now*, and that the page is still watching.

The agenda also shows which elections this voter has already voted in, from the receipt tokens held
on the device (§4.5). There is deliberately no "have I voted?" endpoint — answering that for anyone
but the asker would leak who voted.

### 4.2 Sign-in

USU id and surname, both matching the roll (spec §4). The API's distinction between 401 and 403 is
surfaced as intended:

- **401** — wrong surname or unknown id. Deliberately vague, identically for both.
- **403 `not_checked_in`** — "You're not checked in yet. See the door desk." Actionable.
- **403 `ineligible`** — "Our records show your membership has ended. See the door desk."

### 4.3 The ballot

```
┌──────────────────────────────┐
│ President            1 of 3  │
│ Rank at least 2 candidates.  │   <- from minimumPreferences(seats, candidateCount)
├──────────────────────────────┤
│ YOUR RANKING                 │
│ ⟦1⟧ Alex           ▲  ▼  ✕   │   <- ordinal always visible, 44px targets
│ ⟦2⟧ Cass           ▲  ▼  ✕   │
├──────────────────────────────┤
│ TAP TO ADD                   │
│ Bo                        +  │
│ Dee                       +  │
├──────────────────────────────┤
│        Submit ballot         │   <- sticky, above the home bar
└──────────────────────────────┘
```

**Reordering is arrows only. No drag-and-drop.** Spec §4 says "arrows or drag"; this design chooses
arrows and drops the alternative. Drag is fiddly with a thumb, and it needs a keyboard-accessible
equivalent built anyway — which is arrows. Building both doubles the work on the harder interaction.

- The ordinal is the fix for the legacy defect: rank is shown, not inferred from the order you
  happened to tap.
- Removing preference 2 renumbers 3 onward. It does not discard them, which is what unticking a
  legacy checkbox did.
- The first item's `▲` and the last item's `▼` are disabled, not hidden, so the row does not reflow
  under a thumb that is already moving.
- Submit is disabled below the minimum, with a live count: "Rank at least 2 candidates. You have
  ranked 1." In an `aria-live` region, so a screen reader hears the gate rather than discovering a
  dead button.
- The minimum comes from `minimumPreferences` in `@election/core` — the same function the API calls.

### 4.4 Submission and its failure modes

| Outcome | UI |
| --- | --- |
| `201` | Receipt screen: token shown once, copy button, written to `localStorage` (spec §4). |
| `400` | The reason string from `validateBallot`, which is written to be read by a voter mid-ballot. |
| `403` | "You are no longer checked in — see the door desk." (An officer un-checked them in after sign-in; the API re-verifies inside the transaction.) |
| `409` | "Your ballot is already recorded." Offers the receipt-check screen. |
| `401` | Re-show sign-in **with the draft ranking preserved**, so a lapsed session does not cost a voter their work. |
| network error | See below. |

**A lost response is unrecoverable, and the UI must say so.** If the request commits but the response
is lost, the ballot is recorded and the receipt token is gone forever — it is never stored
server-side. The UI says exactly that: *"Your vote was recorded. We couldn't show you a receipt, so
you won't be able to verify it later."* It must not imply failure, and it must not offer a retry that
reads as a second chance at the receipt. See `docs/superpowers/LIMITATIONS.md` §1.

### 4.5 Receipt

Shows `recorded` or `voided`, and the election name. **Never the preferences** — that is the whole
design of the receipt (spec §4). Offers "void and vote again" while the election is open, which is
the recast path.

The token is written to `localStorage` under `election:receipts:<batchId>`, as spec §4 requires: it is
shown once, is never stored server-side, and a voter who reloads without it has permanently lost the
ability to verify their own ballot. That store is also what the agenda reads to mark an election
voted, and voiding removes the entry so the election is offered again. Every access is guarded —
`localStorage` throws in Safari's private mode and on an exhausted quota, and a voter must never lose
a *ballot* to browser storage. The token is a bearer capability over one ballot, so holding it on the
device is a trade: see `docs/superpowers/LIMITATIONS.md` §15.

---

## 5. The admin app

### 5.1 Routes

```
/                       officer sign-in
/roll                   import: preview counts, then commit
/elections              list · create · candidates (draft only)
/elections/:eid         turnout while open · result once closed
/exports                attendance · ballots · candidates · result.json
/settings               branding · logo upload
/door                   lazy() — own chunk: door sign-in + check-in
```

Plus two paths outside the society prefix: `/` (register, or pick a society you
run) and `/new` (registration), and one that is **deliberately not linked from
anywhere**:

```
/operator               delete a society — operator key, no link, own chunk
```

`/operator` drives the one route that can destroy a sealed result. The path is not
the control — every request it makes carries `SUPER_ADMIN_KEY`, which the API
checks — but the most destructive screen in the system has no business on an
officer's nav, and a link to it would look like a tidy-up rather than a
regression, so a test asserts that none exists. The key lives in component state
for one visit: never `localStorage`, never `sessionStorage`, never a URL, and the
field is a password input. The slug has to be typed back, and the API requires it
again in the body.

**A society's logo renders through `logoSrc()`, in both apps.** A stored
`logo_url` is root-relative (`/api/logos/...`) because that is what the upload
route returns, so putting it straight into a `src` resolves it against the
*frontend's* origin — a different host in production — and the image 404s with
nothing in the console to say why. Both apps therefore prefix the API base for a
root-relative value and leave an `https://` one alone. `alt=""`, because the
society's name is always rendered beside it.

### 5.2 Officer screens

The officer's job on the day is: import the roll, open an election, watch turnout, close, read the
result, export. Those screens get the design effort; the rest are plain forms.

**Two rules the UI must state, not merely enforce:**

- **Candidates freeze at open.** Before the officer opens an election, the UI says so: "once voting
  opens, candidates cannot be added, renamed or removed." The API returns 409 afterwards, but by then
  it is too late to be useful. The legacy app allowed adding a candidate mid-vote, which is the
  defect spec §4 closes.
- **No tally before close.** While open, the election screen shows turnout only — `ballots_cast`,
  `voters_checked_in`, `eligible`. There is deliberately no count preview anywhere in this app,
  because an officer who can watch the result develop and choose when to stop makes every other
  control decorative.

**The roll import shows the diff before committing** — "1,298 eligible, 4 excluded, 0 skipped" — and
`skipped` is displayed even when zero, because a non-zero `skipped` means the export silently dropped
members and that is the number nobody thinks to look for.

**The result screen is the one that needs real design.** IGM was chosen so a scrutineer can check a
printed round table by hand, so the table has to be worth printing: one row per candidate, one column
per round, figures in `--font-figures` and right-aligned, with elected/excluded status, surplus and
transfer value per distribution, and the non-transferable total. Rendered from the stored `rounds`
JSON as `Round[]` from `@election/core`.

**Tie-breaks are labelled from `kind`, never from an assumption:**

- `kind: 'exclusion'` → "Choose who is **excluded**"
- `kind: 'election_order'` → "Choose who is **elected first**"

This is the trap the `resolved_id` rename exists to close: a control labelled "pick the winner" would
collect the opposite of the officer's intent on an exclusion tie, and the resulting document would
look correct. The reason field is required, and it appears in the result document afterwards.

An override warns that it writes a new result superseding the old one and that both are kept.

### 5.3 The door route

Lazy-loaded, so a volunteer's phone downloads the door chunk and not the officer bundle. Mobile-first
for the same reason as the voter app: it runs on a phone, in a queue.

```
┌──────────────────────────────────┐
│ 🔍 lov                           │  <- autofocus; matches name OR USU id
├──────────────────────────────────┤
│ Ada Lovelace       [Check in]    │  <- 44px rows, whole row tappable
│ 2400001                          │
├──────────────────────────────────┤
│ + Add guest (cannot vote)        │  <- §0; separate action, stated plainly
├──────────────────────────────────┤
│ 127 / 1,298 members · 4 guests   │  <- sticky; never summed
└──────────────────────────────────┘
```

- **Search matches surname, first name or USU id.** A member handing over a card is showing the
  number, not spelling their name, so the id is a first-class search key. Case-insensitive substring
  on `first_name`, `last_name`, `"first last"` and `usu_id`. Guests already checked in are searchable
  too, so a volunteer can find one to undo.
- **The roll is fetched once and filtered in memory**, so search is instant and survives a dropped
  connection mid-queue (spec §4).
- **The roll is never written to storage.** Memory only. Persisting 1,300 names and USU ids to a
  volunteer's personal device would put member data outside the reach of the post-AGM purge. The
  cost is that a page reload needs the network — acceptable, since the door session's TTL is an hour
  and a reload usually means re-authenticating anyway. `LIMITATIONS.md` §10.
- **Already checked in shows as checked, with an undo.** Un-checking-in is a real door action, and it
  is the reason ballot submission re-verifies eligibility inside the transaction.
- **Ineligible members appear but cannot be checked in, with the reason visible.** A volunteer needs
  to tell "not a member" from "typo", which is exactly why the API answers 404 and 403 differently.
- **Quorum polls** `GET /quorum` on an interval. Polling, not WebSockets, per spec §1. Members and
  guests are shown as separate figures — `127 / 1,298 members · 4 guests` — never summed, because
  quorum is a proportion of eligible members and a guest is not one.

**Guests (§0).** A `+ Add guest` action takes a name and an optional note, for someone who is in the
room but not on the roll: an observer, a partner organisation, staff. The UI must be explicit that a
guest **cannot vote** — the button is not the same button as checking a member in, and the
confirmation says so. A guest can be removed, because the commonest guest error is a mistaken tap.

If a volunteer searches for someone who is genuinely a member but absent from the export, adding them
as a guest is the wrong answer and the UI should not imply otherwise: the remedy is a corrected export
re-imported by the officer, which the roll import's upsert handles. Saying that on the empty-search
state is worth more than a help page nobody opens.

---

## 6. Error handling and resilience

- **Every screen has a visible error region**, never a `console.error` or a silent no-op. The legacy
  voter app logged three failures to the console and showed the user nothing.
- **A 401 is always recoverable in place.** Re-show sign-in on the same screen and keep any draft
  work, rather than routing to a sign-in page and losing state.
- **Requests that mutate are single-flight.** The submit button disables while in flight, so a
  double-tap on a laggy connection cannot produce a second request — the API would refuse it with
  409, but showing "already voted" to someone who tapped twice is a bad answer to a question they
  did not ask.
- **Nothing retries automatically.** A retried ballot submission is indistinguishable from a second
  vote from the client's point of view. Retry is always a deliberate tap.

---

## 7. Testing

### 7.1 Component and logic tests — Vitest + Testing Library, jsdom, `fetch` stubbed

The tests that matter are the ones covering logic that was actually wrong before:

- **The ranked ballot:** add, remove, reorder, reorder at both boundaries, renumbering after a
  removal, the minimum-preferences gate, and that submitting below the minimum fires no request.
- **The door filter:** matches by surname, by first name and **by USU id**; ineligible rows cannot be
  checked in.
- **Freeze at open:** the candidate controls are absent, not merely disabled, once an election is
  open.
- **Tie-break labelling:** the control's wording derives from `kind`. This is a correctness test
  wearing a UI test's clothes, and it is the one that stops the `winner_id` trap being reintroduced
  at the last layer.
- **Error mapping:** each status and `code` produces its intended remedy.

### 7.2 One Playwright smoke test

Signs a voter in and casts a ballot against a real `wrangler dev` API on localhost, in real Chromium.

Its purpose is narrow and it is the only thing that can serve it: **proving the browser actually
sends the session cookie.** Spec §1's shared-apex precondition fails silently, presents identically
to a CORS misconfiguration, and its blast radius is an entire AGM. jsdom cannot see it, because jsdom
is not a cookie jar with a `SameSite` policy.

It is not a general e2e suite. The API has 359 integration tests; duplicating them through a browser
would be slow and would test the same things twice.

---

## 8. Known limitations

Recorded in `docs/superpowers/LIMITATIONS.md`. The ones this design introduces or inherits directly:

- **§1** a lost submit response costs the voter their receipt, permanently (§4.4 above).
- **§8** authentication cannot be tested on preview URLs; the Playwright smoke is the mitigation.
- **§10** the door roll is lost on reload, deliberately.

---

## 9. Implementation plans

Three plans, executed in order:

- **Plan 2d — guest attendance** (§0). API only: migration `0004`, five endpoints, the purge
  extension and the retention wording. Small, and it must land before 3b because the door screen
  consumes it. Kept separate from 3b so that a schema and integrity change is reviewed as one rather
  than buried in a UI plan.
- **Plan 3a — `apps/voter`** plus `packages/styles` and the `e2e/` smoke. Before 3b because it is
  smaller, it carries the hard UX requirement, and it proves the shared foundation before the larger
  app depends on it.
- **Plan 3b — `apps/admin`**, officer screens and the lazy door route.

## 10. Success criteria

- A ballot can be ranked, reordered and submitted **one-handed on a 320px-wide screen**, with no
  horizontal scroll and every target at least 44px.
- The rank of every preference is visible at all times; removing one renumbers the rest and discards
  nothing.
- A ballot below the minimum cannot be submitted, and the reason is stated before the attempt.
- Candidates cannot be added, renamed or removed in the UI once an election is open, and the rule is
  stated before opening.
- **No count, partial tally or per-candidate figure is reachable in either app before an election is
  closed.**
- A tie-break override control is labelled from the tie's `kind`.
- The door search finds a member by surname, first name or USU id, filters without a network request,
  and no member data is written to browser storage.
- A guest can be added, found and removed at the door; the UI states that a guest cannot vote; and a
  guest **cannot sign in to vote or be checked in as a member** — verified against the API, not only
  in the UI.
- Quorum shows members and guests as separate figures, and adding a guest does not change
  `checked_in` or `eligible`.
- Restyling either app end to end requires editing CSS only — **no `.tsx` file contains a `style`
  attribute or a utility class.**
- Both apps: `npm test` passes, typecheck clean, and the dependency list in §1.2 is unchanged.
