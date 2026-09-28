<script setup lang="ts">
// Главная страница приложения в портале (пункт «Приложения» → aiconnect): что это и в каком
// состоянии. Администратору — ещё и что не настроено на сервере приложения (GET /api/health,
// app/utils/serverHealth.ts) и код приложения для B24_APP_CODE: изнутри портала его видно через
// `app.info`, а без него сервер отклоняет запросы из портала.
import { isPortalAdmin } from '~/utils/profile'
import { serverProblems, type ServerProblem } from '~/utils/serverHealth'

const b24 = useB24()
const isAdmin = ref(false)
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
  b24.getOrThrow().parent.setTitle('aiconnect')
  try {
    isAdmin.value = isPortalAdmin(await b24.call<unknown>('profile'), b24.getOrThrow().auth.isAdmin)
  } catch (e) {
    loadError.value = e instanceof Error ? e.message : String(e)
  }
  if (isAdmin.value) await checkServer()
})
</script>

<template>
  <InPortalGate>
    <div class="p-4 sm:p-6 max-w-3xl mx-auto space-y-4">
      <h1 class="text-xl font-semibold">
        aiconnect
      </h1>
      <p>
        Приложение подключает вашу собственную AI-модель (ваш API-ключ) к BitrixGPT: она появится
        в списках выбора модели в настройках BitrixGPT. Подключение провайдеров — в следующих версиях;
        пока администратору доступен шпион протокола — он показывает, что присылает BitrixGPT.
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
      <B24Button
        v-if="isAdmin"
        color="air-primary"
        label="Шпион протокола"
        to="/spy"
        data-testid="app-spy"
      />
      <B24Alert
        v-if="loadError"
        color="air-primary-alert"
        title="Не удалось узнать, кто открыл приложение"
        :description="loadError"
      />
    </div>
  </InPortalGate>
</template>
