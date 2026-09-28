<script setup lang="ts">
// Публичная страница: что это за приложение. Внутри портала она не используется —
// портал открывает /app (главная) и /install.
useSeoMeta({
  title: 'aiconnect — своя AI-модель в BitrixGPT',
  description: 'Приложение для облачного Битрикс24: подключает вашу собственную AI-модель (ваш API-ключ) к BitrixGPT как провайдера.'
})
</script>

<template>
  <main class="max-w-3xl mx-auto p-6 space-y-6">
    <h1 class="text-2xl font-semibold">
      aiconnect
    </h1>
    <p>
      Приложение для облачного Битрикс24: подключает вашу собственную AI-модель (ваш API-ключ)
      к BitrixGPT. Модель появляется в списках выбора модели в настройках BitrixGPT. Первый провайдер — DeepSeek. Приложение в разработке.
    </p>
    <p class="text-sm opacity-70">
      Установка — из Битрикс24. Исходный код:
      <a
        class="underline"
        href="https://github.com/bx-shef/aiconnect"
        target="_blank"
        rel="noopener"
      >github.com/bx-shef/aiconnect</a>.
    </p>
  </main>
</template>
