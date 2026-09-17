# @election/api

Cloudflare Worker serving the REST API for the election system. See
`docs/superpowers/specs/2026-09-16-election-code-rewrite-design.md` for the
data model and design rationale.

## Version pinning

`wrangler` is pinned to an exact version (not a caret range) in the root
`package.json`. It is coupled to `@cloudflare/vitest-pool-workers`'s bundled
workerd/miniflare runtime and to `@cloudflare/workers-types@^4`: bumping any
one of the three without the others reintroduces peer-dependency conflicts
(newer `wrangler` requires `@cloudflare/workers-types@^5`) or a compatibility
date the bundled runtime doesn't support. Move all three together.
