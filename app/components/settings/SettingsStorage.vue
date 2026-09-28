<script setup lang="ts">
// Хранилище настроек: сколько места занято и замер предела («уточнить, сколько влезет» из ТЗ).
import { DOCUMENTED_OPTION_LIMIT, formatUsage, optionLimit, SAFETY_MARGIN } from '#shared/domain/storageBudget'
import type { ProbeResult, ProbeStep } from '~/utils/storageProbe'

const app = useAppSettings()
const probe = useStorageProbe()
const toast = useToast()

const running = ref(false)
const steps = ref<ProbeStep[]>([])
const result = ref<ProbeResult | null>(null)
const usage = computed(() => app.usageWith({}))
const measuredAt = computed(() => optionLimit(app.options.value).measured?.at ?? '')
const kb = (n: number) => `${(n / 1024).toLocaleString('ru-RU', { maximumFractionDigits: 1 })} КБ`

async function run() {
  const ok = window.confirm(
    'Замер пишет в настройки приложения всё большие пробные данные и проверяет, что они читаются без потерь. '
    + 'Перед замером снимается копия настроек; если что-то испортится, она будет восстановлена. '
    + 'Надёжнее запускать на тестовом портале. Продолжить?'
  )
  if (!ok) return
  running.value = true
  steps.value = []
  result.value = null
  try {
    result.value = await probe.run(step => steps.value.push(step))
    await app.load()
    toast.add({ title: `Замер сохранён: ${kb(result.value.measured.limit)}`, color: 'air-primary-success' })
  } catch (e) {
    toast.add({ title: 'Замер не удался', description: e instanceof Error ? e.message : String(e), color: 'air-primary-alert' })
  } finally {
    running.value = false
  }
}
</script>

<template>
  <div class="space-y-4">
    <p class="text-sm">
      Настройки и ставки хранятся в настройках приложения на портале, а там место ограничено.
      Сейчас занято <b data-testid="storage-usage">{{ formatUsage(usage) }}</b> — это предел
      <b>{{ kb(usage.limit) }}</b> минус запас {{ SAFETY_MARGIN * 100 }}%.
    </p>
    <B24Alert
      v-if="!usage.measured"
      color="air-primary-warning"
      title="Предел не замерен"
      :description="`Пока действует предел из документации ядра Битрикс — ${DOCUMENTED_OPTION_LIMIT} символов. Документация может быть устаревшей — замерьте реальный предел, и бюджет пересчитается от него.`"
    />
    <p
      v-else
      class="text-sm opacity-70"
    >
      Предел замерен {{ measuredAt }} и сохранён в настройках. Повторный замер безопасен.
    </p>

    <B24Button
      color="air-secondary"
      label="Замерить предел"
      :loading="running"
      :disabled="running"
      data-testid="storage-probe"
      @click="run"
    />

    <ol
      v-if="steps.length"
      class="text-sm space-y-1"
    >
      <li
        v-for="(step, i) in steps"
        :key="i"
      >
        {{ step.ok ? '✓' : '✕' }} {{ kb(step.bytes) }}<template v-if="step.note">
          — {{ step.note }}
        </template>
      </li>
    </ol>
    <B24Alert
      v-if="result?.restored"
      color="air-primary-warning"
      title="Настройки восстановлены из копии"
      description="Запись на пределе испортила данные — копия, снятая перед замером, возвращена. Проверьте настройки."
    />
    <p
      v-if="result"
      class="text-sm"
    >
      Итог: без потерь записалось {{ kb(result.measured.limit) }}{{ result.hitLimit ? '' : ' (это верх замера — реальный предел ещё больше)' }}.
    </p>
  </div>
</template>
