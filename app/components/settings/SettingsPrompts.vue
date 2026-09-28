<script setup lang="ts">
// Промпты BitrixGPT: названия строк (свои или системные) и промпты консультаций.
// «Восстановить системный» — это сброс в null: тогда действует актуальный системный промпт.
import { DEFAULT_TASK_TITLE_PROMPT, DEFAULT_TIME_BLOCK_PROMPT } from '#shared/domain/prompts'
import { LIMITS, type AppSettings } from '#shared/domain/settings'

const settings = defineModel<AppSettings>({ required: true })

/** Поле показывает свой промпт, а если его нет — системный (правка создаёт свой). */
function promptModel(key: 'taskTitle' | 'timeBlock', fallback: string) {
  return computed({
    get: () => settings.value.prompts[key] ?? fallback,
    set: (v: string) => { settings.value.prompts[key] = v.trim() && v.trim() !== fallback ? v : null }
  })
}
const taskTitle = promptModel('taskTitle', DEFAULT_TASK_TITLE_PROMPT)
const timeBlock = promptModel('timeBlock', DEFAULT_TIME_BLOCK_PROMPT)

function addConsult() {
  if (settings.value.consultPrompts.length >= LIMITS.consultPrompts) return
  settings.value.consultPrompts.push({ id: `p${Date.now().toString(36)}`, title: '', text: '' })
}

function removeConsult(id: string) {
  settings.value.consultPrompts = settings.value.consultPrompts.filter(p => p.id !== id)
}
</script>

<template>
  <div class="space-y-6">
    <B24Alert
      color="air-secondary"
      description="Промпты используются, когда в общих настройках выбрано «Название строки → через BitrixGPT». Формат ответа (JSON) приложение добавляет само — его в промпте описывать не нужно."
    />

    <B24FormField
      label="Тип 1: задача → название строки"
      :description="settings.prompts.taskTitle ? 'Свой промпт' : 'Действует системный промпт'"
    >
      <div class="space-y-2">
        <B24Textarea
          v-model="taskTitle"
          :rows="4"
          autoresize
          :maxlength="LIMITS.prompt"
          class="w-full"
          data-testid="prompt-task"
        />
        <B24Button
          size="sm"
          color="air-tertiary"
          label="Восстановить системный"
          :disabled="!settings.prompts.taskTitle"
          @click="settings.prompts.taskTitle = null"
        />
      </div>
    </B24FormField>

    <B24FormField
      label="Тип 2: запись времени → название строки"
      :description="settings.prompts.timeBlock ? 'Свой промпт' : 'Действует системный промпт'"
    >
      <div class="space-y-2">
        <B24Textarea
          v-model="timeBlock"
          :rows="4"
          autoresize
          :maxlength="LIMITS.prompt"
          class="w-full"
          data-testid="prompt-time"
        />
        <B24Button
          size="sm"
          color="air-tertiary"
          label="Восстановить системный"
          :disabled="!settings.prompts.timeBlock"
          @click="settings.prompts.timeBlock = null"
        />
      </div>
    </B24FormField>

    <section class="space-y-3">
      <h3 class="font-medium">
        Консультации
      </h3>
      <p class="text-sm opacity-70">
        Промпт запускается из карточки счёта над данными счёта и задач; ответ BitrixGPT сохраняется записью в ленте счёта.
      </p>
      <div
        v-for="p in settings.consultPrompts"
        :key="p.id"
        class="space-y-2 rounded-md border p-3 border-(--ui-color-divider-less)"
      >
        <div class="flex gap-2">
          <B24Input
            v-model="p.title"
            placeholder="Название, например «Риски по счёту»"
            :maxlength="LIMITS.consultTitle"
            class="flex-1"
          />
          <B24Button
            size="sm"
            color="air-secondary-alert"
            label="Удалить"
            @click="removeConsult(p.id)"
          />
        </div>
        <B24Textarea
          v-model="p.text"
          placeholder="Что спросить у BitrixGPT"
          :rows="3"
          autoresize
          :maxlength="LIMITS.prompt"
          class="w-full"
        />
        <p
          v-if="!p.title.trim() || !p.text.trim()"
          class="text-sm text-(--ui-color-accent-main-warning)"
        >
          Без названия и текста промпт не сохранится
        </p>
      </div>
      <B24Button
        color="air-secondary"
        label="Добавить промпт"
        :disabled="settings.consultPrompts.length >= LIMITS.consultPrompts"
        @click="addConsult"
      />
    </section>
  </div>
</template>
