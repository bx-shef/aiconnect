// Nuxt configuration. A single artifact: the Nitro server (`pnpm build` → `.output/server/index.mjs`)
// serves both the app pages and our `/api`. The difference from the client-bank-alfa-by reference app
// (static files behind nginx + separate backend) is deliberate: server-side work (install tokens, later —
// receiving BitrixGPT requests on completions_url) lives next to the pages, and a second artifact would
// cost more than it saves.
// Details — docs/ARCHITECTURE.md.
export default defineNuxtConfig({
  modules: [
    '@nuxt/eslint',
    '@bitrix24/b24ui-nuxt',
    '@vueuse/nuxt'
  ],

  // All pages live inside the Bitrix24 frame and are useless without it: they don't need SSR, and SPA
  // avoids hydration pitfalls with slider redirects (docs/PAGE_GUIDE.md).
  ssr: false,

  devtools: { enabled: false },

  css: ['~/assets/css/main.css'],

  runtimeConfig: {
    public: {
      // Absolute app address (https://…) — the event handler is built from it.
      // Bitrix24 doesn't accept relative addresses in event.bind.
      siteUrl: '',
      // The app's code in the Marketplace / local app — needed for pull events and links.
      b24AppCode: ''
    }
  },

  compatibilityDate: '2025-01-15',

  nitro: {
    // Scripts and styles (/_nuxt, ~2 MB) are compressed at build time into .gz and .br, and Nitro serves
    // them based on Accept-Encoding. In the client-bank reference app that was its nginx; we don't have
    // one, and the shared nginx-proxy doesn't compress on its own (measured 2026-09-25: a script went out
    // at 95 KB without Content-Encoding).
    compressPublicAssets: true,
    storage: {
      // Portal install tokens (server/utils/tokenStore.ts). Path is relative to the process's working
      // directory; in Docker a volume is mounted at `/app/.data` — see docs/DEPLOY.md.
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
