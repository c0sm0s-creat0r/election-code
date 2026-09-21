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
| `apps/api` | Hono on Workers. Bindings: D1, KV, R2. | `api.dalyell.com.au` |
| `apps/voter` | Preact. The ballot. | `vote.dalyell.com.au` |
| `apps/admin` | React 19. Officer screens + the door desk at `/b/:slug/door`. | `admin.dalyell.com.au` |
| `e2e` | One Playwright smoke test. | nothing — run locally |

Three deploys. The door desk is a route of the admin app, not a fourth deployment.

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

Node 20+. You need a Cloudflare account with Workers, D1, KV and R2 enabled.

```bash
npm install
```

### Create the three bindings

```bash
cd apps/api

wrangler d1 create election                 # paste the id into wrangler.jsonc -> d1_databases
wrangler kv namespace create RATE_LIMIT     # paste the id into wrangler.jsonc -> kv_namespaces
wrangler r2 bucket create election-logos    # name already matches wrangler.jsonc
```

`wrangler.jsonc` ships with `"PLACEHOLDER_SET_BY_WRANGLER"` for the D1 and KV ids. Replace both
before the first deploy.

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

Three terminals:

```bash
cd apps/api    && npx wrangler d1 migrations apply election --local && npm run dev   # :8787
cd apps/voter  && npm run dev                                                        # :5173
cd apps/admin  && npm run dev                                                        # :5174
```

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
npm test          # core 142 · admin 65 · api 399 · voter 60
npm run typecheck  # all four workspaces
```

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

## 6. Provisioning a society

Operator only, with the super-admin key:

```bash
curl -X POST https://api.dalyell.com.au/api/batches \
  -H 'content-type: application/json' \
  -H "x-super-admin-key: $SUPER_ADMIN_KEY" \
  -d '{
    "name": "Dalyell Society",
    "slug": "dalyell",
    "officer_password": "<generate: 12+ chars>",
    "door_password": "<generate: 12+ chars>",
    "branding": { "title": "AGM 2026", "org_name": "Dalyell Society",
                  "accent_color": "#2563eb", "logo_url": "" }
  }'
```

The slug becomes the URL voters use: `vote.dalyell.com.au/<slug>`. The officer works at
`admin.dalyell.com.au/b/<slug>`; the door desk is `admin.dalyell.com.au/b/<slug>/door`.

Both passwords are hashed with PBKDF2 at ~210k iterations and are never recoverable. Write them down
somewhere the committee can reach on the day.

---

## 7. Running an AGM

### Before the day

1. **Import the roll.** Officer → *Member roll* → choose the USU member export. You get a preview:
   *"1,298 eligible, 4 excluded, 0 skipped"*. **Look at `skipped`.** Anything above zero means the
   export dropped rows whose columns did not line up, and those members will not be able to vote —
   fix the export and re-import rather than proceeding.
2. **Create each election** and set its seats.
3. **Add every candidate.** This is the last moment. Candidates freeze when voting opens, because
   anyone added later could not have been ranked by people who already voted.
4. Upload a logo and set the accent colour under *Appearance* if you want them.

Re-importing a corrected export is safe at any point: it updates names and eligibility in place and
never deletes anyone.

### On the door

The volunteer signs in at `/b/<slug>/door` on their own phone with the **door** password. The roll
loads once, then search filters instantly with no network — it keeps working if the venue wifi drops.

- Search matches surname, first name **or USU ID**, so a member can just hand over their card.
- Tap *Check in*. Tap again to undo if it was the wrong person.
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

1. Officer opens the election. It refuses to open with fewer candidates than seats.
2. Voters go to `vote.dalyell.com.au/<slug>`, sign in with **USU ID and surname**, rank candidates and
   submit. They are shown a receipt code once.
3. The officer sees turnout only — ballots cast, checked in, eligible. **There is no way to see a
   count while voting is open, and that is the point.**

A voter who wants to change their vote uses their receipt to cancel and vote again.

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

1. **Export everything first.** Under *Exports*: ballots CSV, candidates CSV, sealed result JSON,
   attendance CSV, guests CSV. Keep them with the minutes.
2. **Then purge the roll.** Officer → `DELETE /api/batches/<id>/roll`. It refuses while any election
   is still open or in draft. It deletes the roll, the check-ins and the guest list, and keeps the
   ballots, the seal, the results and the mark-off.

Order matters: the attendance export reads names from the roll, so take it before the purge.

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
| Sign-in works, everything after fails | The three hosts are not on one apex, so the cookie is never sent | Fix the hostnames. **Do not** set `origin: '*'` |
| A door tablet shows a permission error mid-queue | The door session lapsed (see lifetimes below) | Sign in again. The 401/403 split exists so this reads as "sign in", not "not allowed" |
| "Too many attempts" | Rate limit. 30/10min on staff sign-in, 300/10min on voting | Wait. The window is ten minutes, not an hour |
| Close succeeded but there is no result | Worker died between the status flip and the seal | Click close again. It detects closed-but-unsealed and finishes sealing |
| A voter says their vote did not go through | Usually it did — a lost response cannot return the receipt | Check the attendance export for their ID. They cannot get the receipt back; `LIMITATIONS.md` §1 |
| A member is not on the roll | Stale export | Re-import a corrected export, or use **Add member** at the door |

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
- **Never weaken the `guest` table by giving it a `usu_id`.** A guest cannot vote because the
  eligibility query has nothing to match — not because a check says so.
- **Never leave `vote_receipt.live_receipt_hash` set after an election closes.** While set it links a
  voter to their ballot's preferences. Closing clears it.
- **Never write the roll to browser storage.** It would put 1,300 members' details on a personal
  device, outside the purge.
- **Never add a `style` attribute or a utility class to a `.tsx` file.** Semantic classes only — that
  one rule is what lets the styling be replaced later without touching a component.

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
