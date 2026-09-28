<script setup lang="ts">
// We don't set landing page meta tags here: the root component is shared across all pages, including
// utility ones (/install, /settings) — lesson from the reference app (#425 in client-bank-alfa-by).
useHead({
  htmlAttrs: { lang: 'ru' },
  meta: [{ name: 'viewport', content: 'width=device-width, initial-scale=1' }]
})
</script>

<template>
  <NuxtLayout>
    <NuxtPage />
  </NuxtLayout>
</template>
