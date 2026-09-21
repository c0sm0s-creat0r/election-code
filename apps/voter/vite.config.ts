// `defineConfig` from 'vitest/config', not from 'vite': vite's own does not type
// the `test` key, so this file would not typecheck.
import { defineConfig } from 'vitest/config'
import preact from '@preact/preset-vite'

export default defineConfig({
  plugins: [preact()],
  test: {
    environment: 'jsdom',
    globals: true,
    // .ts as well as .tsx — tests/api.test.ts contains no JSX.
    include: ['tests/**/*.test.{ts,tsx}'],
  },
})
