import type { D1Migration } from '@cloudflare/vitest-pool-workers/config'
import type { Env } from '../src/index'

declare module 'cloudflare:test' {
  interface ProvidedEnv extends Env {
    // test-only, injected by vitest.config.ts
    TEST_MIGRATIONS: D1Migration[]
  }
}
