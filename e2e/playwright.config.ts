import { defineConfig } from '@playwright/test'

/**
 * Boots the real API and voter app on localhost, where they share a
 * registrable domain and the cookie behaves as in production. No dev proxy:
 * the request is credentialed and cross-origin.
 */
export default defineConfig({
  testDir: '.',
  // One test. A retry would hide a flaky failure.
  retries: 0,
  reporter: [['list']],
  globalSetup: './seed.ts',
  use: { baseURL: 'http://localhost:5173' },
  webServer: [
    {
      // `--persist-to` gives the run its own database, separate from dev. It also
      // makes `wrangler dev` and `wrangler d1 execute --local` use the same file.
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
