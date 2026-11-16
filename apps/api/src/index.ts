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
  /** One binding per budget. The numbers are in wrangler.jsonc. */
  BATCH_CREATE_LIMITER: RateLimit
  STAFF_SIGNIN_LIMITER: RateLimit
  VOTING_LIMITER: RateLimit
  /** Society logos, keyed by content hash. See routes/logo.ts. */
  LOGOS: R2Bucket
  SUPER_ADMIN_KEY: string
  SESSION_SECRET: string
  /**
   * Comma-separated exact origins allowed to send credentials, e.g.
   * `https://admin.dalyell.com.au,https://vote.dalyell.com.au`. No wildcards.
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
    // Never `*`, never the reflected Origin: browsers reject `*` with
    // credentials. Null omits the header. If authenticated requests fail
    // opaquely, check the hostnames first (docs/EXECUTION.md §1).
    origin: (origin) => {
      const list = allowedOrigins(c.env.ALLOWED_ORIGINS)
      return list.includes(origin) ? origin : null
    },
    credentials: true,
    allowMethods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    allowHeaders: ['content-type', 'x-super-admin-key'],
    // Lets a frontend read a CSV export's filename.
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

// Failures are JSON, so a frontend's res.json() does not throw on a 500. The
// error is logged, not returned: it may describe configuration.
app.onError((err, c) => {
  console.error('unhandled error', err)
  return c.json({ error: 'internal' }, 500)
})

export default app
