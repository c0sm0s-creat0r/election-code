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
import { close } from './routes/close.js'
import { result } from './routes/result.js'
import { override } from './routes/override.js'
import { exports_ } from './routes/exports.js'
import { logo } from './routes/logo.js'
import { purge } from './routes/purge.js'
import { turnout } from './routes/turnout.js'
import { branding } from './routes/branding.js'
import { guests } from './routes/guests.js'
import { doorVoters } from './routes/doorVoters.js'

export type Env = {
  DB: D1Database
  /**
   * Rate-limit bindings, one per budget. Configuration, not a dependency — see
   * src/middleware/rateLimit.ts for why the numbers are as loose as they are.
   */
  BATCH_CREATE_LIMITER: RateLimit
  STAFF_SIGNIN_LIMITER: RateLimit
  VOTING_LIMITER: RateLimit
  /** Society logos, keyed by content hash. See routes/logo.ts. */
  LOGOS: R2Bucket
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

const allowedOrigins = (raw: string | undefined): string[] =>
  (raw ?? '')
    .split(',')
    .map((o) => o.trim())
    .filter((o) => o !== '')

app.use('/api/*', (c, next) =>
  cors({
    /**
     * **Never `origin: '*'`, and never reflect the request's Origin.** Both look
     * like the fix when authenticated requests fail, and neither is: `*` is
     * rejected by browsers alongside credentials, and reflection is `*` with
     * extra steps. When requests fail opaquely, check the deployment hostnames
     * first — docs/EXECUTION.md §1.
     *
     * Returning null omits the header entirely, which is what makes the browser
     * refuse, rather than a header saying "denied".
     */
    origin: (origin) => {
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
app.route('/', close)
app.route('/', result)
app.route('/', override)
app.route('/', exports_)
app.route('/', logo)
app.route('/', purge)
app.route('/', turnout)
app.route('/', branding)
app.route('/', guests)
app.route('/', doorVoters)

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
