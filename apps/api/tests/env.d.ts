import type { D1Migration } from '@cloudflare/vitest-pool-workers/config'
import type { Env } from '../src/index'

declare module 'cloudflare:test' {
  interface ProvidedEnv extends Env {
    // Injected by vitest.config.ts via readD1Migrations; test-only, not part
    // of the production Env.
    TEST_MIGRATIONS: D1Migration[]
  }
}
