import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineWorkersConfig, readD1Migrations } from '@cloudflare/vitest-pool-workers/config'

const migrationsPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations')

export default defineWorkersConfig(async () => {
  // readD1Migrations runs in Node (it reads the filesystem) and returns the
  // parsed migration list. It is passed into the worker as a binding so
  // tests can call `applyD1Migrations(env.DB, env.TEST_MIGRATIONS)` — the
  // worker runtime cannot read `migrations/*.sql` off disk itself.
  const migrations = await readD1Migrations(migrationsPath)

  return {
    test: {
      include: ['tests/**/*.test.ts'],
      poolOptions: {
        workers: {
          wrangler: { configPath: './wrangler.jsonc' },
          miniflare: {
            d1Databases: ['DB'],
            // The binding's counters cannot be reset between tests the way KV
            // could, so integration tests run with limits they never reach.
            // The limiter itself is tested against a fake in rateLimit.test.ts.
            ratelimits: {
              BATCH_CREATE_LIMITER: { simple: { limit: 1_000_000, period: 60 } },
              STAFF_SIGNIN_LIMITER: { simple: { limit: 1_000_000, period: 60 } },
              VOTING_LIMITER: { simple: { limit: 1_000_000, period: 60 } },
            },
            r2Buckets: ['LOGOS'],
            bindings: {
              TEST_MIGRATIONS: migrations,
              SUPER_ADMIN_KEY: 'super-secret-test-key',
              // At least MIN_SECRET_LENGTH (32) characters: signSession
              // refuses a shorter one, so a short fixture would fail every
              // sign-in test rather than the one that means to check it.
              SESSION_SECRET: 'test-session-secret-0123456789abcdef',
              ALLOWED_ORIGINS: 'https://admin.dalyell.com.au,https://vote.dalyell.com.au',
            },
          },
        },
      },
    },
  }
})
