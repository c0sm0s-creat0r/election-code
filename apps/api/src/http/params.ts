import type { Context } from 'hono'

/**
 * A required path parameter. Throws if missing: that is a routing bug, and
 * `?? ''` would bind an empty string into SQL and read as "not found".
 */
export function pathParam(c: Context, name: string): string {
  const value = c.req.param(name)
  if (value === undefined) throw new Error(`route matched without the :${name} parameter`)
  return value
}
