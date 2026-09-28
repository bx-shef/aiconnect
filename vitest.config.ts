import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

// Юнит-тесты чистых функций в node. Алиасы повторяют Nuxt (`~` → app, `#shared` → shared),
// чтобы модули импортировались в тестах так же, как в приложении.
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
