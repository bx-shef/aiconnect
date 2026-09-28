import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

// Смок-набор на ТЕСТОВОМ портале (docs/SMOKE.md): пишет в портал, ходит в BitrixGPT — поэтому
// отдельный конфиг, не часть `pnpm test` и CI. Алиасы — как в vitest.config.ts.
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
    // Один портал, общие данные прогона, лимиты REST — файлы по очереди.
    fileParallelism: false,
    testTimeout: 180_000,
    hookTimeout: 600_000
  }
})
