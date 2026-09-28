import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

// Smoke suite against a TEST portal (docs/SMOKE.md): hits a live portal, hence a
// separate config, not part of `pnpm test` or CI. Aliases — same as vitest.config.ts.
export default defineConfig({
  resolve: {
    alias: {
      '~': fileURLToPath(new URL('./app', import.meta.url)),
      '#shared': fileURLToPath(new URL('./shared', import.meta.url))
    }
  },
  test: {
    name: 'smoke',
    environment: 'node',
    include: ['smoke/**/*.smoke.ts'],
    globalSetup: ['smoke/setup.ts'],
    // A single portal, shared run data, REST limits — files run one at a time.
    fileParallelism: false,
    testTimeout: 180_000,
    hookTimeout: 600_000
  }
})
