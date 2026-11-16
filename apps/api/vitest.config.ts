import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineWorkersConfig, readD1Migrations } from '@cloudflare/vitest-pool-workers/config'

const migrationsPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations')

export default defineWorkersConfig(async () => {
  // Read in Node and passed as a binding: the worker runtime cannot read
  // `migrations/*.sql` from disk.
  const migrations = await readD1Migrations(migrationsPath)

  return {
    test: {
      include: ['tests/**/*.test.ts'],
      poolOptions: {
        workers: {
          wrangler: { configPath: './wrangler.jsonc' },
          miniflare: {
            d1Databases: ['DB'],
            // The binding's counters cannot be reset between tests, so the limits are
            // set out of reach. rateLimit.test.ts uses a fake.
            ratelimits: {
              BATCH_CREATE_LIMITER: { simple: { limit: 1_000_000, period: 60 } },
              STAFF_SIGNIN_LIMITER: { simple: { limit: 1_000_000, period: 60 } },
              VOTING_LIMITER: { simple: { limit: 1_000_000, period: 60 } },
            },
            r2Buckets: ['LOGOS'],
            bindings: {
              TEST_MIGRATIONS: migrations,
              SUPER_ADMIN_KEY: 'super-secret-test-key',
              // at least MIN_SECRET_LENGTH (32), or every sign-in test fails
              SESSION_SECRET: 'test-session-secret-0123456789abcdef',
              ALLOWED_ORIGINS: 'https://admin.dalyell.com.au,https://vote.dalyell.com.au',
            },
          },
        },
      },
    },
  }
})
