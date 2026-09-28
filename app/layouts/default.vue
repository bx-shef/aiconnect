<script setup lang="ts">
// B24App даёт тосты, модалки и локаль компонентов. overflow-x-clip, а не hidden: hidden ломает sticky
// (урок эталона client-bank-alfa-by, #530 там).
import { ru } from '@bitrix24/b24ui-nuxt/locale'
</script>

<template>
  <B24App :locale="ru">
    <div class="min-h-screen w-full overflow-x-clip">
      <slot />
    </div>
  </B24App>
</template>
