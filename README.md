# election-code

Elections for the Dalyell Society: a member roll, a door desk, ranked ballots on a phone, and a
single-transferable-vote count that can be re-run offline in front of whoever is disputing it.

**To set it up, deploy it, or run an AGM with it: [`docs/EXECUTION.md`](docs/EXECUTION.md).**

| | |
| --- | --- |
| Design and rationale | [`docs/superpowers/specs/2026-09-16-election-code-rewrite-design.md`](docs/superpowers/specs/2026-09-16-election-code-rewrite-design.md) |
| Frontend design | [`docs/superpowers/specs/2026-09-21-frontends-design.md`](docs/superpowers/specs/2026-09-21-frontends-design.md) |
| **Accepted limitations** | [`docs/superpowers/LIMITATIONS.md`](docs/superpowers/LIMITATIONS.md) — eleven entries, all deliberate |
| Current state | [`docs/superpowers/HANDOFF.md`](docs/superpowers/HANDOFF.md) |
| API configuration | [`apps/api/README.md`](apps/api/README.md) |

## Layout

```
packages/core      STV count, ballot validation, CSV import. Zero dependencies.
packages/styles    Design tokens and element defaults, shared by both frontends.
apps/api           Hono on Cloudflare Workers. D1, KV, R2.
apps/voter         Preact. The ballot.
apps/admin         React 19. Officer screens, and the door desk as its own chunk.
e2e                One Playwright test: proves the session cookie really travels.
```

```bash
npm install
npm test           # core 142 · admin 65 · api 399 · voter 60
npm run typecheck
npm run e2e        # needs: npx playwright install chromium
```

## The legacy system

`backend/`, `admin-frontend/` and `voter-frontend/` are the previous implementation, kept for now
because `backend/irv.py` is still the reference in a differential test. It stored every election in
process memory on a host that spins down when idle, which is the problem this rewrite exists to solve.
Nothing new should be added to those directories.
