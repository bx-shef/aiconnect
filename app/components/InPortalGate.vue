<script setup lang="ts">
// Пропускает содержимое, только если страница открыта во фрейме Битрикс24. Это забота об
// интерфейсе, а не защита: права проверяют портал (вызовы из фрейма) и наш сервер (frameAuth.ts).

const INIT_TIMEOUT_MS = 10_000

const b24 = useB24()
const state = ref<'checking' | 'ok' | 'outside'>('checking')

onMounted(async () => {
  const frame = await Promise.race([
    b24.init(),
    new Promise<undefined>(resolve => setTimeout(() => resolve(undefined), INIT_TIMEOUT_MS))
  ])
  state.value = frame ? 'ok' : 'outside'
})
</script>

<template>
  <div
    v-if="state === 'checking'"
    class="p-6 space-y-3"
    aria-busy="true"
  >
    <B24Skeleton class="h-8 w-64" />
    <B24Skeleton class="h-24 w-full" />
  </div>
  <div
    v-else-if="state === 'outside'"
    class="p-6"
  >
    <B24Alert
      color="air-primary-warning"
      title="Откройте приложение в Битрикс24"
      description="Эта страница работает только внутри портала: в карточке счёта (меню верхней кнопки → «Заполнить из задач») или из раздела «Приложения»."
    />
  </div>
  <slot v-else />
</template>
