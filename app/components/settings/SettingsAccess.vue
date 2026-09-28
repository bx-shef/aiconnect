<script setup lang="ts">
// Кто кроме администраторов может менять ставки. Остальные настройки — только администратор.
import type { AppSettings } from '#shared/domain/settings'

const settings = defineModel<AppSettings>({ required: true })
const users = useUsers()

onMounted(() => users.load(settings.value.rateEditors))

async function add() {
  const ids = await users.pickMany()
  settings.value.rateEditors = [...new Set([...settings.value.rateEditors, ...ids])]
}

function remove(id: number) {
  settings.value.rateEditors = settings.value.rateEditors.filter(x => x !== id)
}
</script>

<template>
  <div class="space-y-3">
    <p class="text-sm opacity-80">
      Администраторы портала меняют ставки всегда. Здесь — сотрудники, которым это разрешено дополнительно.
    </p>
    <ul
      v-if="settings.rateEditors.length"
      class="space-y-1"
    >
      <li
        v-for="id in settings.rateEditors"
        :key="id"
        class="flex items-center gap-3"
      >
        <span class="flex-1">{{ users.label(id) }}</span>
        <B24Button
          size="xs"
          color="air-tertiary"
          label="Убрать"
          @click="remove(id)"
        />
      </li>
    </ul>
    <p
      v-else
      class="text-sm opacity-70"
    >
      Никого не назначено
    </p>
    <B24Button
      color="air-secondary"
      label="Добавить сотрудников"
      data-testid="access-add"
      @click="add"
    />
  </div>
</template>
