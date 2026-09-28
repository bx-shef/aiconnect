<script setup lang="ts">
// B24App provides toasts, modals, and component locale. overflow-x-clip, not hidden: hidden breaks sticky
// (lesson from the client-bank-alfa-by reference app, #530 there).
import { ru } from '@bitrix24/b24ui-nuxt/locale'
</script>

<template>
  <B24App :locale="ru">
    <div class="min-h-screen w-full overflow-x-clip">
      <slot />
    </div>
  </B24App>
</template>
