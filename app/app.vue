<script setup lang="ts">
// Мета-теги лендинга здесь не ставим: корневой компонент общий для всех страниц, включая
// служебные (/install, /settings), — урок эталона (#425 в client-bank-alfa-by).
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
