<script setup lang="ts">
// Установка приложения в портал: проверить права → подписка на события → installFinish.
// ⚠ event.bind ДО installFinish: иначе ONAPPINSTALL (токены установки) не придёт.
// ⚠ После installFinish портал перезагружает страницу — показывать что-то после него бесполезно
//   (подсказка с кодом приложения поэтому живёт на главной, pages/app.vue).
// Страницу можно открыть и после установки (смена адреса сервера): тогда подписки обновляются,
// а installFinish не вызывается — вне режима установки SDK на нём падает.
// Провайдеры BitrixGPT (`ai.engine.register`) здесь не регистрируются — это этапы 1–3 docs/PLAN.md.

import { eventBindCalls, missingScopes, staleEventHandlers } from '~/utils/install'

type StepState = 'wait' | 'run' | 'ok' | 'warn' | 'fail'
interface Step {
  key: string
  label: string
  state: StepState
  note?: string
}

const b24 = useB24()
const config = useRuntimeConfig()
const steps = ref<Step[]>([
  { key: 'scope', label: 'Проверка прав приложения', state: 'wait' },
  { key: 'events', label: 'Подписка на события установки и удаления', state: 'wait' },
  { key: 'finish', label: 'Завершение установки', state: 'wait' }
])
const fatal = ref('')
const done = ref(false)

function mark(key: string, state: StepState, note?: string) {
  const step = steps.value.find(s => s.key === key)
  if (step) Object.assign(step, { state, note })
}

async function runInstall() {
  const frame = b24.getOrThrow()
  frame.parent.setTitle('Установка приложения')
  // Адрес приложения нужен абсолютный. В разработке берём текущий, в бою — из конфигурации.
  const siteUrl = config.public.siteUrl || window.location.origin

  mark('scope', 'run')
  const granted = await b24.call<string[]>('scope')
  const missing = missingScopes(granted)
  mark('scope', missing.length ? 'warn' : 'ok', missing.length ? `Не выданы права: ${missing.join(', ')} — добавьте их в карточке приложения` : undefined)

  // Сначала — новое, потом снимаем старое: если регистрация упадёт, у приложения останется хотя
  // бы прежняя подписка на удаление.
  mark('events', 'run')
  const existing = await b24.call<unknown[]>('event.get')
  for (const ev of eventBindCalls(siteUrl, existing)) await b24.call(ev.method, ev.params)
  for (const stale of staleEventHandlers(siteUrl, existing)) {
    await b24.call('event.unbind', stale).catch(() => undefined)
  }
  mark('events', 'ok')

  mark('finish', 'run')
  if (frame.isInstallMode) {
    await frame.installFinish()
    mark('finish', 'ok')
  } else {
    mark('finish', 'ok', 'приложение уже было установлено — подписки обновлены')
  }
  done.value = true
}

onMounted(async () => {
  if (!await b24.init()) return
  try {
    await runInstall()
  } catch (e) {
    fatal.value = e instanceof Error ? e.message : String(e)
    const running = steps.value.find(s => s.state === 'run')
    if (running) running.state = 'fail'
  }
})

const icon: Record<StepState, string> = { wait: '○', run: '…', ok: '✓', warn: '!', fail: '✕' }
</script>

<template>
  <InPortalGate>
    <div class="p-6 max-w-2xl mx-auto space-y-4">
      <B24Card>
        <template #header>
          <h1 class="text-lg font-semibold">
            Установка aiconnect
          </h1>
        </template>
        <ol class="space-y-2">
          <li
            v-for="step in steps"
            :key="step.key"
            class="flex gap-3"
            :data-testid="`install-step-${step.key}`"
          >
            <span
              class="w-5 text-center font-mono"
              aria-hidden="true"
            >{{ icon[step.state] }}</span>
            <span>
              {{ step.label }}
              <span
                v-if="step.note"
                class="block text-sm opacity-70"
              >{{ step.note }}</span>
            </span>
          </li>
        </ol>
      </B24Card>
      <B24Alert
        v-if="fatal"
        color="air-primary-alert"
        title="Установка не завершена"
        :description="fatal"
      />
      <B24Alert
        v-if="done"
        color="air-primary-success"
        title="Готово"
        description="Приложение установлено. Подключение своей модели к BitrixGPT появится в следующих версиях."
      />
    </div>
  </InPortalGate>
</template>
