// Конфигурация Nuxt. Один артефакт: Nitro-сервер (`pnpm build` → `.output/server/index.mjs`)
// отдаёт и страницы приложения, и наш `/api`. Отличие от эталона client-bank-alfa-by (там
// статика за nginx + отдельный backend) — сознательное: серверная работа (токены установки, дальше —
// приём запросов BitrixGPT на completions_url) живёт рядом со страницами, и второй артефакт стоил
// бы дороже, чем экономит.
// Подробно — docs/ARCHITECTURE.md.
export default defineNuxtConfig({
  modules: [
    '@nuxt/eslint',
    '@bitrix24/b24ui-nuxt',
    '@vueuse/nuxt'
  ],

  // Все страницы живут во фрейме Битрикс24 и без него бесполезны: SSR им не нужен, а SPA
  // избавляет от ловушек гидрации с редиректами слайдера (docs/PAGE_GUIDE.md).
  ssr: false,

  devtools: { enabled: false },

  css: ['~/assets/css/main.css'],

  runtimeConfig: {
    public: {
      // Абсолютный адрес приложения (https://…) — из него строится обработчик событий.
      // Битрикс24 не принимает относительные адреса в event.bind.
      siteUrl: '',
      // Код приложения в Маркете / локального приложения — нужен pull-событиям и ссылкам.
      b24AppCode: ''
    }
  },

  compatibilityDate: '2025-01-15',

  nitro: {
    // Скрипты и стили (/_nuxt, ~2 МБ) сжимаются при сборке в .gz и .br, и Nitro отдаёт их по
    // Accept-Encoding. В эталоне client-bank это делал его nginx; у нас его нет, а общий
    // nginx-proxy сам не сжимает (замер 2026-09-25: скрипт ушёл 95 КБ без Content-Encoding).
    compressPublicAssets: true,
    storage: {
      // Токены установки порталов (server/utils/tokenStore.ts). Путь относительно рабочего
      // каталога процесса; в Docker на `/app/.data` смонтирован том — см. docs/DEPLOY.md.
      portals: { driver: 'fs', base: './.data/portals' }
    }
  },

  eslint: {
    config: {
      stylistic: {
        commaDangle: 'never',
        braceStyle: '1tbs'
      }
    }
  }
})
