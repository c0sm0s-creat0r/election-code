# @election/api

Cloudflare Worker serving the REST API for the election system. See
`docs/superpowers/specs/2026-09-16-election-code-rewrite-design.md` for the
data model and design rationale.

## Configuration

Two secrets and one plain variable. Nothing here belongs in `wrangler.jsonc`
except `ALLOWED_ORIGINS`, which is not a secret.

### `SESSION_SECRET` — the HMAC key for every session cookie

```sh
openssl rand -base64 32 | wrangler secret put SESSION_SECRET   # deployed
cp .dev.vars.example .dev.vars                                  # local dev
```

A missing or short one is not a silent degradation: every sign-in answers
`503 server_not_configured`, naming nothing, and the reason appears in the
Worker's log.

**This one value is the entire door → officer boundary, and it is the only
thing standing in its way.** A session token is a base64url payload beside
its signature: the payload is *plaintext*, and a door volunteer holds one on
their own phone for the length of an AGM. Anyone with a token can therefore
attack the secret offline — no rate limit, no lockout, nothing logged, no
network round-trip to notice. Recovering it does not merely forge a door
session; it mints `{"role":"officer","batchId":"<any batch>"}` for every
society in the system.

A *missing* secret already fails closed — WebCrypto rejects a zero-length
HMAC key — so the dangerous case is a short one, which works perfectly right
up until someone cracks it. `signSession` therefore refuses any secret under
32 characters (`MIN_SECRET_LENGTH` in `src/auth/session.ts`), so a weak
secret fails loudly at setup instead of silently at an AGM. Generate it;
never type one.

Rotating it invalidates every live session, which means everyone signs in
again — so rotate between events, not during one.

### `SUPER_ADMIN_KEY` — the operator's key

```sh
openssl rand -base64 32 | wrangler secret put SUPER_ADMIN_KEY
```

Sent as the `x-super-admin-key` header. Two routes take it:

- `POST /api/batches` — optional. Signup is open, so the key only marks a
  society as operator-created rather than self-registered.
- `DELETE /api/batches/:id` — **required, and irreversible.** It deletes every
  row a society owns and its logo objects, and it is the only route in the
  system that can destroy an `election_seal` or an `election_result`. It also
  requires `confirm_slug` in the body to equal the society's own slug, because
  the id is a UUID nobody proofreads.

Held by the operator and by nobody else — not by an officer, and never in a
frontend bundle or a `VITE_` variable. The admin app's `/operator` screen takes
it as typed input for one request and stores it nowhere; it is not linked from
anywhere in the app, and a test asserts that stays true.

A denied attempt on either route is written to `audit_log` with a `NULL`
`batch_id` (`batch.create.denied` / `batch.delete.denied`); the supplied key is
never recorded, not even as a prefix. A *successful* delete is recorded too, as
counts — `audit_log` has no foreign key to `batch` precisely so that it does not
cascade away with the society it describes.

### `ALLOWED_ORIGINS` — the CORS allow-list

Comma-separated exact origins (scheme and host, no trailing slash, no
wildcards), set as a plain var in `wrangler.jsonc` or via the dashboard:

```
https://admin.dalyell.com.au,https://vote.dalyell.com.au
```

Anything not on this list gets no `Access-Control-Allow-Origin` header at
all. See the comment in `src/index.ts` before changing it — in particular,
when authenticated requests fail opaquely in a browser, check the deployment
hostnames against the shared-apex precondition in spec §1 *first*. That
failure looks identical to a CORS failure, and "fixing" it here with
`origin: '*'` or by reflecting the request's `Origin` rebuilds the exact hole
spec §6 exists to close.

### The bindings are real, and `wrangler dev` uses them

D1 and R2 exist, their ids are in `wrangler.jsonc`, and migrations
`0001`–`0004` are applied to the remote database.

All three bindings carry `"remote": true`, so **`npm run dev` reads and writes
production data.** Wrangler prints `remote` beside each one at startup. A society
registered while experimenting locally is on the live list; `--local` migrations
and `wrangler d1 execute --local` touch a sqlite file nothing reads. The flag
only affects `wrangler dev` — a deployed Worker always uses the real resources —
so deleting those three lines is free in production and hands local dev its own
database back.

Note also that `migrations/0001_initial.sql` has now been applied to the
production D1 and is immutable — every later schema change goes in a new
numbered migration.

## Version pinning

`wrangler` is pinned to an exact version (not a caret range) in the root
`package.json`. It is coupled to `@cloudflare/vitest-pool-workers`'s bundled
workerd/miniflare runtime and to `@cloudflare/workers-types@^4`: bumping any
one of the three without the others reintroduces peer-dependency conflicts
(newer `wrangler` requires `@cloudflare/workers-types@^5`) or a compatibility
date the bundled runtime doesn't support. Move all three together.
