# Running the election system

Everything needed to set this up, develop on it, deploy it, and run an AGM with it.

For *why* it is built this way, read
`docs/superpowers/specs/2026-09-16-election-code-rewrite-design.md`. For what it deliberately does
**not** do, read `docs/superpowers/LIMITATIONS.md` — that file is short and every entry matters.

---

## 1. What runs where

| Package | What it is | Deploys to |
| --- | --- | --- |
| `packages/core` | STV count, ballot validation, CSV import. Zero dependencies. | nothing — imported |
| `packages/styles` | Design tokens and element defaults, shared by both frontends. | nothing — imported |
| `apps/api` | Hono on Workers. Bindings: D1, R2, rate limiters. | `api.dalyell.com.au` |
| `apps/voter` | Preact. The ballot. | `vote.dalyell.com.au` |
| `apps/admin` | React 19. Officer screens + the check-in desk at `/b/:slug/door`. | `admin.dalyell.com.au` |
| `e2e` | One Playwright smoke test. | nothing — run locally |

Three deploys. The check-in desk is a route of the admin app, not a fourth deployment.

**One naming note.** The desk is called the **check-in desk** everywhere a person can see it. Its URL is
still `/door`, its session role is still `door`, and the API field is still `door_password` — renaming
those would invalidate every live session and rewrite the audit trail for a label. Do not "fix" the
mismatch by renaming the API.

### The precondition that breaks everything if you get it wrong

**All three deployments must sit on subdomains of one shared apex.** `SameSite` is judged by
registrable domain, not by subdomain, so on `*.workers.dev`, `*.pages.dev` or `*.vercel.app` the
session cookie **is never sent** and every authenticated request fails — with nothing in any error
message pointing at the cause. It looks exactly like a CORS misconfiguration, and the fix that
suggests itself (`origin: '*'`) reopens a hole the design closes.

If sign-in appears to work and every request afterwards is unauthorised, **check the hostnames
before you touch anything else.**

---

## 2. First-time setup

Node 20+. You need a Cloudflare account with Workers, D1 and R2 enabled.

```bash
npm install
```

### Create the three bindings

```bash
cd apps/api

wrangler d1 create election                 # paste the id into wrangler.jsonc -> d1_databases
wrangler r2 bucket create election-logos    # name already matches wrangler.jsonc
```

**Already done, as of 2026-09-22.** All three exist, the real ids are in `wrangler.jsonc`, and
migrations `0001`–`0004` are applied to the remote database. `wrangler d1 migrations list election
--remote` confirms it.

### Set the two secrets

```bash
openssl rand -base64 32 | wrangler secret put SESSION_SECRET
openssl rand -base64 32 | wrangler secret put SUPER_ADMIN_KEY
```

Generate them; never type one. `SESSION_SECRET` is the entire door → officer boundary and is refused
below 32 characters — `apps/api/README.md` explains why at length, and it is worth reading once.

`SUPER_ADMIN_KEY` provisions societies and is held by the operator alone. It never goes in a frontend
bundle or any `VITE_` variable.

### Set the CORS allow-list

In `wrangler.jsonc` (not a secret — a browser is told the answer anyway):

```jsonc
"vars": { "ALLOWED_ORIGINS": "https://admin.dalyell.com.au,https://vote.dalyell.com.au" }
```

Exact origins, comma-separated. No wildcards, no trailing slashes.

### Apply the migrations

```bash
wrangler d1 migrations apply election --remote
```

**Once a migration is applied to the production database it is immutable.** Editing an applied
migration leaves the deployed schema untouched while the local test database silently diverges. Every
later schema change goes in a new numbered file.

---

## 3. Local development

**First, the local secrets.** `wrangler dev` does not read the production secrets, so it needs its
own file — without it every sign-in answers `503 server_not_configured`:

```bash
cd apps/api
cp .dev.vars.example .dev.vars
openssl rand -base64 32        # paste as SESSION_SECRET in .dev.vars
```

`.dev.vars` is gitignored. `SESSION_SECRET` must be at least 32 characters; a short or missing one is
refused deliberately, because it is the whole door → officer boundary.

Then three terminals:

```bash
cd apps/api    && npm run dev                                                        # :8787
cd apps/voter  && npm run dev                                                        # :5173
cd apps/admin  && npm run dev                                                        # :5174
```

### `npm run dev` uses the PRODUCTION database — read this before experimenting

All three bindings in `wrangler.jsonc` carry `"remote": true`, so `wrangler dev` runs the Worker
locally and sends every D1 query and R2 upload to the **real** resources. Wrangler says so
on startup:

```
env.DB (election)          D1 Database    remote
env.LOGOS (election-logos) R2 Bucket      remote
```

So a society you register while poking around locally is a society on the live list, and deleting an
election locally deletes it for real. `--local` migrations and `wrangler d1 execute --local` are
operating on a sqlite file that nothing is reading.

`"remote": true` only affects `wrangler dev`; a deployed Worker always uses the real resources
regardless. **Removing those three lines is therefore free in production and gives local dev its own
database back** — do it if you want to experiment without touching live data. The e2e suite is
unaffected either way: `--persist-to .wrangler-e2e` forces local mode for the run, which is why no
`e2e` society appears in the live list.

**One failure mode that comes with remote bindings:** an occasional

```
D1_ERROR: Failed to parse body as JSON, got: error code: 1031
```

on any query, and a `500` from the route that made it. That is a Cloudflare edge error, not a D1 or
SQL error — the proxy between `wrangler dev` and D1 answered with an error page where JSON belonged.
The database is fine; restart `wrangler dev`. It cannot happen with local bindings.

Add both dev origins to `ALLOWED_ORIGINS` for local work:
`http://localhost:5173,http://localhost:5174`.

Two things that will otherwise waste an hour:

- **Cookies are not port-scoped**, so `localhost:5173` and `localhost:8787` share a cookie jar and
  `SameSite=Strict` is satisfied — the registrable domain is `localhost` either way. This is why auth
  *can* be tested locally but not on preview URLs.
- **Do not remove `Secure` from the session cookie to make local work.** Browsers treat `localhost`
  as a secure context and accept it over plain HTTP. If sign-in works but later requests do not, it
  is an origin problem, and dropping `Secure` would ship a session cookie in clear text.

There is deliberately **no Vite dev proxy**. It would work and it would hide the credentialed
cross-origin request until production.

---

## 4. Testing

```bash
npm test           # core 138 · admin 78 · api 404 · voter 60
npm run typecheck  # all four workspaces
```

**If the API suite reports "Runner @cloudflare/vitest-pool-workers is not supported"**, the
`vitest` / `@cloudflare/vitest-pool-workers` pair has drifted — an `npm install` can move them
independently, and the API's 404 tests then stop running silently. The root `package.json` pins the
working pair and overrides `@vitest/runner` and `@vitest/snapshot` to `vitest`'s own version; move
all of them together or not at all.

```bash
npx playwright install chromium   # once, ~95 MB
npm run e2e                       # one browser smoke test
```

`npm test` deliberately excludes the e2e suite, because it needs a browser binary and the default
suite must never depend on one. That is why the e2e workspace's script is called `e2e` and not
`test` — renaming it back silently pulls Playwright into every run.

The e2e test exists for one reason: **proving a real browser actually sends the session cookie.**
jsdom cannot, because jsdom is not a cookie jar with a `SameSite` policy. Run it before a deploy.

---

## 5. Deploying

```bash
cd apps/api && npm run deploy
```

Then the two frontends as Cloudflare Pages projects, each built with `npm run build` and served from
`dist/`, with `VITE_API_BASE=https://api.dalyell.com.au` set at build time. Attach the custom
domains — `vote.` and `admin.` on the same apex as `api.` — **before** testing auth, per §1.

Post-deploy, verify in this order:

1. `curl https://api.dalyell.com.au/api/health` → `{"status":"ok"}`
2. Sign in as an officer on `admin.dalyell.com.au`, then reload. If you are still signed in, the
   cookie is travelling.
3. `GET /api/batches/<id>/elections` from a browser on `vote.dalyell.com.au` returns candidates and
   **no ballots and no attendees**. That public route returning voter data was the legacy hole.

---

## 6. Registering a society

**Societies register themselves.** Go to **`admin.dalyell.com.au/new`** and fill in:

- the society's name, and the web address derived from it (voters will use `vote.dalyell.com.au/<slug>`)
- an **officer password** — full control of every election
- a **check-in desk password** — check-in only, and it must be different from the officer password
- an accent colour

Then write both passwords down. They are hashed with PBKDF2 and **cannot be recovered or reset** —
there is no email in this system, so there is no reset path. Losing the officer password means losing
the society.

Afterwards you get all three URLs: `/b/<slug>` for officers, `/b/<slug>/door` for the check-in desk, and
`/<slug>` on the voter site. `admin.dalyell.com.au/` lists every registered society, so nobody needs
to memorise a slug.

**Registration is open and verifies nothing.** Anyone can register, and appearing in the list is not
an endorsement — the frontends say so. What protects an election is that a new society starts with an
empty roll: it can only enfranchise the members it imports, and it can never see another society's
members, ballots or results.

`SUPER_ADMIN_KEY` is no longer needed to create a society, but it is still honoured: a request that
offers a *wrong* key is refused and audited, and one created with a valid key is recorded as an
operator action rather than a self-registration.

## 7. Running an AGM

### Before the day

1. **Import the roll.** Officer → *Member roll* → choose the USU member export. You get a preview:
   *"1,298 eligible, 4 excluded, 0 skipped"*. **Look at `skipped`.** Anything above zero means the
   export dropped rows whose columns did not line up, and those members will not be able to vote —
   fix the export and re-import rather than proceeding.
2. **Create each election** under *Elections*, and set its seats.
3. **Add every candidate**, from the election's own screen. This is the last moment: candidates
   freeze when voting opens, because anyone added later could not have been ranked by people who
   already voted.
4. Upload a logo and set the accent colour under *Appearance* if you want them.

Re-importing a corrected export is safe at any point: it updates names and eligibility in place and
never deletes anyone.

### On the door

The volunteer signs in at `/b/<slug>/door` on their own phone with the **door** password. **It asks
every time**, deliberately: this is the one device that gets handed round a desk, and the officer's
own browser holds an officer session that is not a door session. If the session ends mid-shift the
password form comes back with a reason rather than leaving the screen stuck.

The roll loads once, then search filters instantly with no network — it keeps working if the venue wifi
drops.

- Search matches surname, first name **or USU ID**, so a member can just hand over their card.
- Tap *Check in*. If it was the wrong person, *Check out* reverses it.
- An ineligible member appears but cannot be checked in, with the reason shown. That is a membership
  question, not a typo.
- **Add guest** — someone attending who is not a member. They are counted in the head-count and
  **cannot vote**.
- **Add member** — someone genuinely eligible whom the export missed. They **can** vote. Use this only
  for someone whose membership you have confirmed; they are flagged in the attendance export so the
  count stays defensible. If the ID is already on the roll you will be told to search instead.

Quorum shows as `checked-in / eligible`, with guests and door additions as separate figures. They are
never added together, because quorum is a proportion of eligible members.

### Opening and voting

**Open each election when the agenda reaches it. Do not open them all at the start.** Only an `open`
election is visible to a voter, and nothing prevents opening several at once — but a voter holding
their phone can see every open ballot, so opening the lot turns a sequence of agenda items into one
long form.

1. Officer opens the election. It refuses to open with fewer candidates than seats.
2. Voters go to `vote.dalyell.com.au/<slug>`, sign in with **USU ID and surname**, then pick the
   election from the list of what is open, rank candidates and submit. They are shown a receipt code
   once.
3. The officer sees turnout only — ballots cast, checked in, eligible. **There is no way to see a
   count while voting is open, and that is the point.**

**Tell the room to leave the page open.** The voter app checks for newly opened elections every ten
seconds, so the next one appears on its own — nobody needs to reload or sign in again. Voters who
already voted in everything open see "keep this page open", never "you are finished": the app has no
way to know the meeting is over, so it never claims it (`LIMITATIONS.md` §16).

A voter who wants to change their vote uses their receipt to cancel and vote again. Their receipt
codes are kept on their own device, so the elections they have voted in stay marked across a reload.

### Closing and the result

1. Officer closes the election. This **seals the ballots and cannot be undone** — you are asked to
   confirm.
2. The result appears: winners, the quota, the full round-by-round table, every tie-break with its
   method, and the digest of the sealed ballots.
3. If a tie was decided by draw and your constitution requires lots drawn in the room, override it.
   **Read the control's wording**: for an exclusion tie it asks who is *excluded*, not who wins. A
   reason is required, and the override writes a new result that supersedes the old one — both are
   kept.
4. Repeat for each election.

### After the AGM

1. **Export everything first.** The per-election files — ballots CSV, candidates CSV, sealed result
   JSON, that election's attendance — are **on the result page**, beside the digest they describe. The
   whole-AGM attendance and the guest list are under *Exports*. Keep them all with the minutes.
2. **Then purge the roll.** Officer → `DELETE /api/batches/<id>/roll`. It refuses while any election
   is still open or in draft. It deletes the roll, the check-ins and the guest list, and keeps the
   ballots, the seal, the results and the mark-off.

Order matters: the attendance export reads names from the roll, so take it before the purge.

### Deleting an election

An officer can delete an election **only while nobody has voted in it**. Open it on the elections
screen, then *Delete this election* → *Yes, delete this election*.

That covers the cases that are always mistakes: a misnamed draft, an election opened against the
wrong roll, a rehearsal before the meeting. Once a single ballot is in the box the delete refuses and
tells you how many there are — including a ballot that was cancelled, because the row stays in the
table so the seal still covers it. There is no way to override this, and that is the point: an
officer password can remove a mistake and can never remove a vote.

If you need a *closed* election with real ballots gone — a whole rehearsal AGM, say — delete the
society instead.

### Deleting a society (operator only)

**This is the one irreversible action in the system, and the only thing that can destroy a sealed
result.** It removes the society's roll, check-ins, guests, elections, candidates, ballots, receipts,
seals, results and logo. There is no backup inside the system; D1 Time Travel is the only recovery
and it is outside this app.

Two ways, both needing `SUPER_ADMIN_KEY`:

```sh
# The screen: not linked from anywhere, by design.
open https://admin.dalyell.com.au/operator

# Or directly. Both the key and the slug are required.
curl -X DELETE https://api.dalyell.com.au/api/batches/<batch-id> \
  -H 'content-type: application/json' \
  -H "x-super-admin-key: $SUPER_ADMIN_KEY" \
  -d '{"confirm_slug":"<the-society-slug>"}'
```

The slug has to be typed back because the id is a UUID nobody proofreads. A wrong key gives `401`
and is recorded; a slug that does not match gives `409` and changes nothing.

**What survives:** the audit log. It is the one table with no foreign key to the society, so it does
not disappear with it, and the deletion is recorded there as counts — how many elections, ballots and
roll entries went — never a name, a slug or a USU id. Deleting a society also frees its slug, so the
name can be registered again.

Before doing it on a society that has actually run an election, take the exports first. Afterwards
there is nothing left to export from.

---

## 8. If a disputed result has to be re-counted

The exported ballot CSV plus the candidate CSV can be re-counted offline with `packages/core`, on a
laptop, in front of whoever is disputing it — no database and no network.

The ballot CSV carries `ballot_id,preferences,voided`, which is exactly what the seal digest is
computed over, so a third party can recompute `ballots_sha256` from the file and confirm they hold
the sealed ballots **before** recounting them. Note that `recount()` does not verify the digest for
you: the check belongs to the auditor.

---

## 9. When something goes wrong

| Symptom | Cause | What to do |
| --- | --- | --- |
| Every sign-in returns 503 `server_not_configured` | `SESSION_SECRET` is missing or under 32 characters | Locally: create `apps/api/.dev.vars` (§3). Deployed: `wrangler secret put SESSION_SECRET` |
| Sign-in works, everything after fails | The three hosts are not on one apex, so the cookie is never sent | Fix the hostnames. **Do not** set `origin: '*'` |
| A check-in tablet shows a permission error mid-queue | The desk session lapsed (see lifetimes below) | The password form returns by itself with a reason. Just re-enter the check-in desk password |
| "Too many attempts" | Rate limit, per IP. 10/min on staff sign-in, 600/min on voting, 3/min on sign-up | Wait one minute. On venue wifi the whole room is one IP; mobile data avoids that |
| Close succeeded but there is no result | Worker died between the status flip and the seal | Click close again. It detects closed-but-unsealed and finishes sealing |
| A voter says their vote did not go through | Usually it did — a lost response cannot return the receipt | Check the attendance export for their ID. They cannot get the receipt back; `LIMITATIONS.md` §1 |
| A member is not on the roll | Stale export | Re-import a corrected export, or use **Add member** at the door |
| An officer cannot find an election they just made | — | Elections are listed under *Elections*, drafts included. If the list is empty after a reload, the session lapsed: sign in again |

### Session lifetimes

| Role | Lifetime | Why |
| --- | --- | --- |
| Officer | 8 hours | An AGM runs long, and re-authenticating mid-count is worse than a longer session on a laptop the officer controls |
| Voter | 4 hours | Long enough for a late-running agenda, short enough that a phone left on a table is not live tomorrow |
| Door | 1 hour | It lives on a volunteer's phone, which may be handed round or left somewhere |

None of them renew. A door volunteer working a long queue **will** be asked to sign in again, which is
expected rather than a fault — and eligibility is re-checked inside the ballot transaction regardless
of how fresh any cookie is, so the TTLs are a convenience bound rather than the security control.

---

## 10. Things that must never be done

Each of these was a real decision, and each has a short reason.

- **Never reopen a closed election.** There is no route for it. An officer who can reopen can watch a
  result and choose when to stop, which makes every other control decorative.
- **Never add a seeding or test-only route to `apps/api`.** A route that provisions voters is the
  worst thing that could exist here, and "only enabled in dev" is how it reaches production. `e2e`
  seeds through the documented endpoints.
- **Never put a `usu_id`, a ballot id or a preference list into `audit_log`.** That table cannot be
  purged, and a usu_id beside a ballot event rebuilds the correlation the secret ballot removes.
  `AuditEntry.detail` is an allow-list; adding an audited action means making that decision.
- **Never surface a per-candidate figure before an election is closed.** Not on the turnout screen,
  not anywhere.
- **Never edit an applied migration.** New numbered file.
- **Never relax CORS to `*` or to a reflected origin.**
- **Never lower or remove the 32-character `SESSION_SECRET` floor** to make a deployment start. A
  short secret is brute-forceable offline with no rate limit and no trace, and recovering it mints an
  officer session for every society. Failing loudly at setup is the point.
- **Never weaken the `guest` table by giving it a `usu_id`.** A guest cannot vote because the
  eligibility query has nothing to match — not because a check says so.
- **Never leave `vote_receipt.live_receipt_hash` set after an election closes.** While set it links a
  voter to their ballot's preferences. Closing clears it.
- **Never write the roll to browser storage.** It would put 1,300 members' details on a personal
  device, outside the purge.
- **Never add a `style` attribute or a utility class to a `.tsx` file.** Semantic classes only — that
  one rule is what lets the styling be replaced later without touching a component.
- **Never link to `/operator` from anywhere in the admin app.** It deletes societies, sealed results
  included. The key is the control, but putting the screen in an officer's nav is how someone reaches
  for it by accident. A test asserts no link exists.
- **Never let `SUPER_ADMIN_KEY` be stored by a frontend** — not in `localStorage`, not in a
  `sessionStorage` entry, not in a URL, and never in a `VITE_` variable. It is typed when it is used.
- **Never give the officer role a way to delete an election with ballots in it.** The no-ballot test
  is in the SQL, on every statement, not in the screen.

---

## 11. Before the first real election

One thing is genuinely outstanding, and it matters more than anything else in this document.

**There is no known-answer corpus for multi-seat counts.** The count is verified by 200 randomised
property tests plus a differential against the legacy implementation at `seats = 1` only, so **no
surplus-transfer code is compared against a published result**. Two real multi-seat defects have
already passed all 200 property tests.

Before running any election with `seats >= 2`, enter two published multi-seat counts as fixtures —
Scottish council wards publish full round-by-round transfer tables, and the AEC publishes worked
Senate examples. It is about an afternoon's work. `LIMITATIONS.md` §3.

Also worth doing once: read `LIMITATIONS.md` end to end. It is eleven short entries, and every one is
a trade-off someone deliberately accepted rather than a gap nobody noticed.
