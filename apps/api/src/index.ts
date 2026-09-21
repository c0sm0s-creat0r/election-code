import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { batches } from './routes/batches.js'
import { auth } from './routes/auth.js'
import { roll } from './routes/roll.js'
import { checkIn } from './routes/checkIn.js'
import { elections } from './routes/elections.js'
import { voter } from './routes/voter.js'
import { ballots } from './routes/ballots.js'
import { receipts } from './routes/receipts.js'

export type Env = {
  DB: D1Database
  /**
   * Fixed-window rate-limit counters. Configuration, not a dependency — see
   * src/middleware/rateLimit.ts for why the numbers are as loose as they are.
   */
  RATE_LIMIT: KVNamespace
  SUPER_ADMIN_KEY: string
  SESSION_SECRET: string
  /**
   * Comma-separated exact origins allowed to make credentialed requests —
   * e.g. `https://admin.dalyell.com.au,https://vote.dalyell.com.au`.
   * Scheme and host, no trailing slash, no wildcards.
   */
  ALLOWED_ORIGINS: string
}

const app = new Hono<{ Bindings: Env }>()

/**
 * CORS. Spec §6 lists the legacy `CORS(app)` — fully open — as a hole to
 * close, and spec §1 requires `Access-Control-Allow-Credentials: true`
 * against an explicit origin.
 *
 * **Never relax this to `origin: '*'` or to reflecting the request's Origin
 * header.** Both look like the fix when authenticated requests are failing,
 * and neither is: `*` is rejected by browsers in combination with
 * credentials, and reflection is `*` with extra steps — it grants every site
 * on the internet credentialed access to an officer's session.
 *
 * The reason the temptation will arise is worth stating. A cross-origin
 * failure here is *indistinguishable in the browser* from the shared-apex
 * precondition in spec §1 (a `SameSite=Strict` cookie is simply not sent
 * when the API and the frontend differ by registrable domain). Both present
 * as "authenticated requests fail with an opaque error". If sign-in appears
 * to work but every subsequent request is unauthorised, check the deployment
 * hostnames *before* touching this middleware.
 */
const allowedOrigins = (raw: string | undefined): string[] =>
  (raw ?? '')
    .split(',')
    .map((o) => o.trim())
    .filter((o) => o !== '')

app.use('/api/*', (c, next) =>
  cors({
    origin: (origin) => {
      // Exact match against the allow-list only. Returning null omits the
      // Access-Control-Allow-Origin header entirely, which is what makes the
      // browser refuse — not a header saying "denied".
      const list = allowedOrigins(c.env.ALLOWED_ORIGINS)
      return list.includes(origin) ? origin : null
    },
    credentials: true,
    allowMethods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    allowHeaders: ['content-type', 'x-super-admin-key'],
    // The attendance and ballot CSV exports are cross-origin under spec §1.
    // A frontend that fetches one to a blob cannot read its filename without
    // this; an <a download> navigation would work, a fetch would not.
    exposeHeaders: ['content-disposition'],
    maxAge: 600,
  })(c, next),
)

app.get('/api/health', (c) => c.json({ status: 'ok' }))

app.route('/', batches)
app.route('/', auth)
app.route('/', roll)
app.route('/', checkIn)
app.route('/', elections)
app.route('/', voter)
app.route('/', ballots)
app.route('/', receipts)

app.notFound((c) => c.json({ error: 'not found' }, 404))

/**
 * Every route in this API answers JSON, including its failures. Hono's default
 * handler returns a text/plain "Internal Server Error", so a frontend calling
 * res.json() throws on the parse and surfaces a parse error instead of the 500
 * that actually happened — the sort of thing that wastes an hour at an AGM.
 *
 * The error itself is logged, never returned: assertUsableSecret and similar
 * guards throw messages about configuration that a caller has no business
 * reading.
 */
app.onError((err, c) => {
  console.error('unhandled error', err)
  return c.json({ error: 'internal' }, 500)
})

export default app
