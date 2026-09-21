import type { Context } from 'hono'

/**
 * Reads a path parameter the route cannot match without.
 *
 * Hono types every parameter `string | undefined`, and under
 * `noUncheckedIndexedAccess` that propagates into every query binding. The
 * alternatives are both worse than a throw: `?? ''` binds an empty string into
 * SQL, which silently matches nothing and reads to a caller as "not found",
 * and a non-null assertion turns the same mistake into an unchecked lie. A
 * route reaching here with the parameter missing is a routing bug in this
 * codebase, not bad input, so it belongs in `app.onError` as a 500 — never a
 * 404 that sends someone looking for a record that was never named.
 */
export function pathParam(c: Context, name: string): string {
  const value = c.req.param(name)
  if (value === undefined) throw new Error(`route matched without the :${name} parameter`)
  return value
}
