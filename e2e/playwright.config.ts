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
      // `--local` keeps D1 on disk in .wrangler; no Cloudflare account needed.
      command:
        'npx wrangler d1 migrations apply election --local'
        + ' && npx wrangler dev --port 8787'
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
