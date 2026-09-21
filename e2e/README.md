# e2e

One Playwright test. Its only job is proving that **the browser actually sends the session cookie**.

Spec §1's shared-apex precondition fails silently: `SameSite` is judged by registrable domain, so on
mismatched hosts the cookie is never sent, every authenticated request 401s, and it looks exactly like
a CORS misconfiguration — for which the tempting fix reinstates a hole the design closed. jsdom cannot
see any of that, because jsdom is not a cookie jar with a `SameSite` policy.

This is not a general e2e suite and should not become one. `apps/api` has 399 integration tests and
`apps/voter` has its own component tests; driving the same assertions through a browser would be
slower and prove less.

## Running it

```bash
npx playwright install chromium     # once, ~95 MB
npm run e2e                         # from the repo root
```

`playwright.config.ts` starts `wrangler dev --local` on 8787 and the voter app on 5173 and applies the
D1 migrations; `seed.ts` then provisions a society, a roll, a checked-in member and an open election
**through the real API**.

## Why the run has its own database

`--persist-to .wrangler-e2e` keeps every byte this run writes out of the database `npm run dev` uses.

That matters because societies are listed publicly: without it, each run registered another `e2e`
society that then appeared on the landing page. Isolating the state beats deleting rows afterwards or
filtering them out of a production endpoint — the test data never exists anywhere a developer or a
voter can see.

It also settles a confusion worth knowing about: on the default path, `wrangler dev` and
`wrangler d1 execute --local` resolve to two *different* sqlite files, so anything done through one is
invisible to the other. Naming the path explicitly makes both agree.

That database persists between runs, so `seed.ts` is idempotent: it tolerates the society already
existing, closes any election a previous run left open, and opens a fresh one. Exactly one society
and one open election, however many times it runs.

## If a run fails to start

`Error: http://localhost:5173 is already used` means an interrupted run left a server behind.
`reuseExistingServer` is deliberately `false` — reusing a running dev server would point the test at
the *dev* database, defeating the isolation above — so clear the ports instead:

```bash
for p in 5173 8787; do lsof -ti:$p | xargs kill; done
```

## Why there is no seeding endpoint

`seed.ts` uses only documented endpoints with the dev super-admin key — the same path an operator
takes. **Never add a seeding or test-only route to `apps/api`.** A route that provisions voters would
be the worst thing in this codebase, and "it's only enabled in dev" is how such a thing reaches
production.

## It is not part of `npm test`

It needs a downloaded browser binary. The default suite must never depend on one.

**This workspace's script is deliberately called `e2e`, not `test`.** The root `npm test` runs
`--workspaces --if-present`, so naming it `test` silently pulls Playwright into every run of the
default suite — which happened once and was caught by noticing Playwright output where it did not
belong.
