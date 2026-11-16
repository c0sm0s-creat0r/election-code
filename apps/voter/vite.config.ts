// from 'vitest/config': vite's own `defineConfig` does not type the `test` key
import { defineConfig } from 'vitest/config'
import preact from '@preact/preset-vite'

export default defineConfig({
  plugins: [preact()],
  test: {
    environment: 'jsdom',
    globals: true,
    // .ts as well as .tsx: tests/api.test.ts has no JSX.
    include: ['tests/**/*.test.{ts,tsx}'],
  },
})
