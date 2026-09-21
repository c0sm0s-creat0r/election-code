# @election/api

Cloudflare Worker serving the REST API for the election system. See
`docs/superpowers/specs/2026-09-16-election-code-rewrite-design.md` for the
data model and design rationale.

## Configuration

Two secrets and one plain variable. Nothing here belongs in `wrangler.jsonc`
except `ALLOWED_ORIGINS`, which is not a secret.

### `SESSION_SECRET` — the HMAC key for every session cookie

```sh
openssl rand -base64 32 | wrangler secret put SESSION_SECRET
```

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

### `SUPER_ADMIN_KEY` — provisions batches

```sh
openssl rand -base64 32 | wrangler secret put SUPER_ADMIN_KEY
```

Sent as the `x-super-admin-key` header on `POST /api/batches`, the only route
that creates a tenant. Held by the operator and by nobody else — not by an
officer, and never in a frontend bundle or a `VITE_` variable. A denied
attempt is written to `audit_log` with a `NULL` `batch_id`; the supplied key
is never recorded, not even as a prefix.

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

### Not yet set

`wrangler.jsonc` still carries `"database_id": "PLACEHOLDER_SET_BY_WRANGLER"`
for the `DB` binding. Nothing is deployed yet; create the database with
`wrangler d1 create election` and paste the real id in before the first
deploy. Note also that once `migrations/0001_initial.sql` has been applied to
a production D1 it is immutable — every later schema change goes in a new
numbered migration.

## Version pinning

`wrangler` is pinned to an exact version (not a caret range) in the root
`package.json`. It is coupled to `@cloudflare/vitest-pool-workers`'s bundled
workerd/miniflare runtime and to `@cloudflare/workers-types@^4`: bumping any
one of the three without the others reintroduces peer-dependency conflicts
(newer `wrangler` requires `@cloudflare/workers-types@^5`) or a compatibility
date the bundled runtime doesn't support. Move all three together.
