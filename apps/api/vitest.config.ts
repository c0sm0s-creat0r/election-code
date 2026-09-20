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
            bindings: {
              TEST_MIGRATIONS: migrations,
              SUPER_ADMIN_KEY: 'super-secret-test-key',
              SESSION_SECRET: 'test-secret-value',
            },
          },
        },
      },
    },
  }
})
