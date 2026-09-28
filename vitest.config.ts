import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

// Unit tests for pure functions in node. Aliases mirror Nuxt (`~` → app, `#shared` → shared),
// so modules import in tests the same way they do in the app.
export default defineConfig({
  resolve: {
    alias: {
      '~': fileURLToPath(new URL('./app', import.meta.url)),
      '#shared': fileURLToPath(new URL('./shared', import.meta.url))
    }
  },
  test: {
    name: 'unit',
    environment: 'node',
    include: ['tests/**/*.test.ts']
  }
})
