<script setup lang="ts">
// Главная страница приложения в портале (пункт «Приложения» → «Счёт из задач»): что умеет,
// готовы ли настройки, куда идти дальше. Администратору — ещё и что не настроено на сервере
// приложения (GET /api/health, app/utils/serverHealth.ts) и код приложения для B24_APP_CODE:
// изнутри портала его видно через `app.info`, а без него сервер отклоняет запросы из портала.
import { settingsProblems } from '#shared/domain/settings'
import { serverProblems, type ServerProblem } from '~/utils/serverHealth'

const b24 = useB24()
const app = useAppSettings()
const problems = computed(() => settingsProblems(app.settings.value))
const loadError = ref('')
const serverIssues = ref<ServerProblem[]>([])
const appCode = ref('')

/** Проверка сервера — только для администратора: сотруднику чинить это нечем. */
async function checkServer(): Promise<void> {
  const health = await $fetch('/api/health').catch(() => null)
  serverIssues.value = serverProblems(health)
  if (serverIssues.value.some(p => p.variable === 'B24_APP_CODE')) {
    const info = await b24.call<{ CODE?: unknown }>('app.info').catch(() => null)
    appCode.value = typeof info?.CODE === 'string' ? info.CODE : ''
  }
}

onMounted(async () => {
  if (!await b24.init()) return
  b24.getOrThrow().parent.setTitle('Счёт из задач')
  try {
    await app.load()
  } catch (e) {
    loadError.value = e instanceof Error ? e.message : String(e)
  }
  if (app.isAdmin.value) await checkServer()
})
</script>

<template>
  <InPortalGate>
    <div class="p-4 sm:p-6 max-w-3xl mx-auto space-y-4">
      <h1 class="text-xl font-semibold">
        Счёт из задач
      </h1>
      <p>
        Приложение заполняет товарную часть счёта по задачам и затраченному в них времени: ставки
        сотрудников, округление и наценки задаются здесь, в настройках.
      </p>

      <B24Alert
        v-if="serverIssues.length"
        :color="serverIssues.some(p => p.blocking) ? 'air-primary-alert' : 'air-primary-warning'"
        title="Сервер приложения настроен не полностью"
        data-testid="app-server-problems"
      >
        <template #description>
          <ul class="list-disc pl-5 space-y-1">
            <li
              v-for="p in serverIssues"
              :key="p.variable"
            >
              <code class="font-mono">{{ p.variable }}</code> — {{ p.effect }}.
            </li>
          </ul>
          <p
            v-if="appCode"
            class="mt-2"
          >
            Код приложения для <code class="font-mono">B24_APP_CODE</code>:
            <code
              class="font-mono"
              data-testid="app-code"
            >{{ appCode }}</code>
          </p>
          <p class="mt-2">
            Передайте это тому, кто обслуживает сервер приложения: переменные задаются в его окружении.
          </p>
        </template>
      </B24Alert>
      <B24Alert
        v-if="loadError"
        color="air-primary-alert"
        title="Настройки не загрузились"
        :description="loadError"
      />
      <template v-else-if="app.loaded.value">
        <B24Alert
          v-if="problems.length"
          color="air-primary-warning"
          title="Нужна настройка"
          :description="`${problems.join('; ')}. ${app.isAdmin.value ? 'Откройте настройки.' : 'Попросите администратора портала.'}`"
        />
        <B24Alert
          v-else
          color="air-primary-success"
          title="Готово к работе"
          :description="`Ставок: ${app.rates.value.length}. Валюта: ${app.settings.value.currency}.`"
        />
      </template>

      <B24Card>
        <template #header>
          <h2 class="font-semibold">
            Как пользоваться
          </h2>
        </template>
        <ol class="list-decimal pl-5 space-y-1">
          <li>Откройте счёт → верхняя кнопка карточки (слева от «Документ») → «Заполнить из задач».</li>
          <li>Выберите, откуда брать задачи: из сделки счёта или привязанные к самому счёту.</li>
          <li>Выберите расчёт: задача — одна строка, или каждая запись времени — строка.</li>
          <li>Проверьте предпросмотр и запишите строки в счёт.</li>
        </ol>
      </B24Card>

      <div class="flex gap-2">
        <B24Button
          v-if="app.isAdmin.value || app.mayEditRates.value"
          color="air-primary"
          label="Настройки"
          to="/settings"
          data-testid="app-settings"
        />
      </div>
    </div>
  </InPortalGate>
</template>
