import { defineConfig } from '@playwright/test'

/**
 * Boots the real API and the real voter app, on localhost, where all three parties
 * share a registrable domain and the session cookie behaves as it will in
 * production (spec §1). The API's ALLOWED_ORIGINS includes the Vite origin, so the
 * run exercises the genuine credentialed cross-origin request rather than hiding
 * it behind a dev proxy.
 */
export default defineConfig({
  testDir: '.',
  // One test, and it must not be flaky-retried into looking healthy.
  retries: 0,
  reporter: [['list']],
  globalSetup: './seed.ts',
  use: { baseURL: 'http://localhost:5173' },
  webServer: [
    {
      /**
       * `--persist-to` gives the run its **own** database, separate from the one
       * `npm run dev` uses.
       *
       * Without it the smoke test registers a society in the dev database, and
       * since societies are now listed publicly, every run left another `e2e`
       * entry on the landing page. Isolating the state is better than deleting
       * rows afterwards or filtering them out of a production endpoint: the test
       * data never exists anywhere a developer or a voter can see.
       *
       * It also settles a confusion worth knowing about: with the default path,
       * `wrangler dev` and `wrangler d1 execute --local` resolve to two different
       * sqlite files, so anything done through one is invisible to the other.
       * Naming the path explicitly means both commands below agree.
       */
      command:
        'npx wrangler d1 migrations apply election --local --persist-to .wrangler-e2e'
        + ' && npx wrangler dev --port 8787 --persist-to .wrangler-e2e'
        + ' --var SUPER_ADMIN_KEY:e2e-super-admin-key'
        + ' --var SESSION_SECRET:e2e-session-secret-0123456789abcdef'
        + ' --var ALLOWED_ORIGINS:http://localhost:5173',
      cwd: '../apps/api',
      url: 'http://localhost:8787/api/health',
      reuseExistingServer: false,
      timeout: 120_000,
    },
    {
      command: 'npm run dev',
      cwd: '../apps/voter',
      url: 'http://localhost:5173',
      reuseExistingServer: false,
      timeout: 120_000,
    },
  ],
})
