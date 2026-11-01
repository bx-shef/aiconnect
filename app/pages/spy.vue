<script setup lang="ts">
// Stage 1 protocol spy (docs/PLAN.md), portal admin only: registers "TEST <category>" providers
// whose completions_url points at our spy endpoint, shows what Bitrix24 sent and how the callback
// went. Registration runs from the frame (ai.engine.* needs the app context: a provider registered
// by webhook gets app_code null — docs/RESEARCH.md); captures come from GET /api/spy.
import { isPortalAdmin } from '~/utils/profile'
import { engineState, parseEngineList, registerPlan, unregisterPlan, type EngineRecord, type SpyEngine } from '~/utils/spy'

interface Capture {
  id?: string
  at: string
  category: string
  keys: string[]
  bodyBytes: number
  contentType: string
  body: unknown
  scenario?: string
  journalId?: string
  callback: { target: string, host?: string, samePortal?: boolean, status?: number, error?: string }
}
interface SpyState {
  enabled: boolean
  /** Full-text journal on (B24_SPY_FULL=1 on the server). */
  full: boolean
  engines: SpyEngine[]
  mode: 'error' | 'echo'
  scenario: string
  journal: { entries: number, bytes: number, scenarios: string[] } | null
  captures: Capture[]
}

const b24 = useB24()
const api = useApi()
const isAdmin = ref<boolean | null>(null)
const state = ref<SpyState | null>(null)
const registered = ref<EngineRecord[]>([])
const busy = ref(false)
const error = ref('')
const scenarioInput = ref('')
const exportScenario = ref('')
/** Full records opened from the capture list, by journal id. */
const fullText = ref<Record<string, unknown>>({})

const stateLabel = { absent: 'не зарегистрирован', ok: 'зарегистрирован', stale: 'старый адрес' } as const

/** `keepError` — after an action: its error must stay visible, the reload must not wipe it. */
async function load(keepError = false): Promise<void> {
  if (!keepError) error.value = ''
  try {
    state.value = await api.get<SpyState>('/api/spy')
    scenarioInput.value = state.value.scenario ?? ''
    // A label that is no longer in the journal would export an empty list.
    if (exportScenario.value && !state.value.journal?.scenarios.includes(exportScenario.value)) exportScenario.value = ''
    if (state.value.enabled) registered.value = parseEngineList(await b24.call('ai.engine.list'))
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  }
}

async function run(action: () => Promise<void>): Promise<void> {
  busy.value = true
  error.value = ''
  try {
    await action()
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    busy.value = false
    await load(true)
  }
}

const registerAll = () => run(async () => {
  for (const c of registerPlan(state.value?.engines ?? [], registered.value)) await b24.call(c.method, c.params)
})
const unregisterAll = () => run(async () => {
  for (const c of unregisterPlan(state.value?.engines ?? [], registered.value)) await b24.call(c.method, c.params)
})
const setMode = (mode: 'error' | 'echo') => run(async () => {
  await api.post('/api/spy', { mode })
})
const clearCaptures = () => run(async () => {
  await api.post('/api/spy', { clear: true })
})
const saveScenario = () => run(async () => {
  await api.post('/api/spy', { scenario: scenarioInput.value })
})
const clearJournal = () => run(async () => {
  await api.post('/api/spy', { clearJournal: true })
  fullText.value = {}
})
const showFull = (id: string) => run(async () => {
  fullText.value = { ...fullText.value, [id]: await api.get<unknown>(`/api/spy/journal?id=${encodeURIComponent(id)}`) }
})
/** The journal goes through our API with the frame token, so the file is built here, not by a link. */
const downloadJournal = () => run(async () => {
  const q = exportScenario.value ? `?scenario=${encodeURIComponent(exportScenario.value)}` : ''
  const data = await api.get<unknown>(`/api/spy/journal${q}`)
  const url = URL.createObjectURL(new Blob([JSON.stringify(data)], { type: 'application/json' }))
  const a = document.createElement('a')
  a.href = url
  a.download = `spy-journal${exportScenario.value ? `-${exportScenario.value}` : ''}.json`
  a.click()
  // Some browsers start the download after click() returns: revoke later, not at once.
  setTimeout(() => URL.revokeObjectURL(url), 60_000)
})

onMounted(async () => {
  if (!await b24.init()) return
  b24.getOrThrow().parent.setTitle('Шпион протокола')
  try {
    isAdmin.value = isPortalAdmin(await b24.call<unknown>('profile'), b24.getOrThrow().auth.isAdmin)
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
    return
  }
  if (isAdmin.value) await load()
})
</script>

<template>
  <InPortalGate>
    <div class="p-4 sm:p-6 max-w-4xl mx-auto space-y-4">
      <h1 class="text-xl font-semibold">
        Шпион протокола
      </h1>
      <p>
        Регистрирует тестовых провайдеров «TEST …» во всех категориях BitrixGPT. Выберите такого
        провайдера в настройках BitrixGPT и сделайте запрос в портале — здесь появится, что прислал
        Битрикс24. Модели за шпионом нет: он отвечает ошибкой (или тестовым текстом).
      </p>

      <B24Alert
        v-if="isAdmin === false"
        color="air-primary-warning"
        title="Только для администратора портала"
        data-testid="spy-not-admin"
      />
      <B24Alert
        v-if="error"
        color="air-primary-alert"
        title="Ошибка"
        :description="error"
        data-testid="spy-error"
      />

      <B24Alert
        v-if="state && !state.enabled"
        color="air-primary-warning"
        title="Шпион выключен для этого портала"
        description="Шпион — инструмент разработки: он работает только на тестовых порталах из переменной B24_SPY_PORTALS на сервере приложения (docs/DEPLOY.md)."
        data-testid="spy-disabled"
      />

      <template v-if="state && state.enabled">
        <B24Card>
          <template #header>
            <h2 class="font-semibold">
              Провайдеры
            </h2>
          </template>
          <table
            class="w-full text-sm"
            data-testid="spy-engines"
          >
            <thead>
              <tr class="text-left">
                <th class="py-1 pr-2">
                  Категория
                </th>
                <th class="py-1 pr-2">
                  Код
                </th>
                <th class="py-1">
                  Состояние
                </th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="engine in state.engines"
                :key="engine.code"
                :data-testid="`spy-engine-${engine.category}`"
              >
                <td class="py-1 pr-2">
                  {{ engine.category }}
                </td>
                <td class="py-1 pr-2 font-mono">
                  {{ engine.code }}
                </td>
                <td class="py-1">
                  {{ stateLabel[engineState(engine, registered)] }}
                </td>
              </tr>
            </tbody>
          </table>
          <details
            class="mt-2 text-xs"
            data-testid="spy-urls"
          >
            <summary class="cursor-pointer">
              Адреса completions_url (коробка: регистрация из PHP)
            </summary>
            <p class="mt-1">
              На коробке нет REST ai.engine.register: движки регистрирует
              \Bitrix\AI\ThirdParty\Manager::register() с этими адресами (docs/DEPLOY.md §4).
            </p>
            <p
              v-for="engine in state.engines"
              :key="`url-${engine.code}`"
              class="font-mono break-all"
            >
              {{ engine.category }}: {{ engine.completionsUrl }}
            </p>
          </details>
          <div class="flex flex-wrap gap-2 mt-3">
            <B24Button
              color="air-primary"
              label="Зарегистрировать все"
              :loading="busy"
              data-testid="spy-register"
              @click="registerAll"
            />
            <B24Button
              color="air-secondary"
              label="Снять все"
              :loading="busy"
              data-testid="spy-unregister"
              @click="unregisterAll"
            />
          </div>
        </B24Card>

        <B24Card>
          <template #header>
            <h2 class="font-semibold">
              Как отвечать
            </h2>
          </template>
          <p class="text-sm mb-2">
            Сейчас: <b data-testid="spy-mode">{{ state.mode === 'echo' ? 'тестовым текстом' : 'ошибкой' }}</b>.
            Ошибка возвращает порталу списанный лимит; тестовый текст показывает, как портал принимает
            успешный ответ (для категории image всё равно ошибка — картинок у шпиона нет).
          </p>
          <div class="flex flex-wrap gap-2">
            <B24Button
              :color="state.mode === 'error' ? 'air-primary' : 'air-secondary'"
              label="Отвечать ошибкой"
              :loading="busy"
              data-testid="spy-mode-error"
              @click="setMode('error')"
            />
            <B24Button
              :color="state.mode === 'echo' ? 'air-primary' : 'air-secondary'"
              label="Отвечать тестовым текстом"
              :loading="busy"
              data-testid="spy-mode-echo"
              @click="setMode('echo')"
            />
          </div>
        </B24Card>

        <B24Card>
          <template #header>
            <h2 class="font-semibold">
              Сценарий и полный журнал
            </h2>
          </template>
          <p class="text-sm mb-2">
            Метка сценария ставится на следующие запросы (латиница, цифры, «.», «_», «-», до 64 знаков,
            например <span class="font-mono">chat.deal-stage</span>). Пусто — без метки.
          </p>
          <div class="flex flex-wrap gap-2 items-center">
            <B24Input
              v-model="scenarioInput"
              placeholder="сценарий"
              data-testid="spy-scenario"
            />
            <B24Button
              color="air-secondary"
              label="Сохранить метку"
              :loading="busy"
              data-testid="spy-scenario-save"
              @click="saveScenario"
            />
            <span class="text-sm">Сейчас: <b data-testid="spy-scenario-current">{{ state.scenario || '—' }}</b></span>
          </div>
          <p
            class="text-sm mt-3"
            data-testid="spy-full"
          >
            Полный текст: <b>{{ state.full ? 'вкл' : 'выкл' }}</b>.
            <template v-if="state.full && state.journal">
              В журнале {{ state.journal.entries }} запросов, {{ (state.journal.bytes / 1024).toFixed(0) }} КБ
              (хранится до 500 запросов и 50 МБ; auth и адреса callback скрыты).
            </template>
            <template v-else>
              Включается переменной B24_SPY_FULL=1 на сервере стенда; без неё строки обрезаны до 500 знаков.
            </template>
          </p>
          <div
            v-if="state.full && state.journal"
            class="flex flex-wrap gap-2 items-center mt-2"
          >
            <select
              v-model="exportScenario"
              class="border rounded px-2 py-1 text-sm"
              data-testid="spy-export-scenario"
            >
              <option value="">
                все сценарии
              </option>
              <option
                v-for="sc in state.journal.scenarios"
                :key="sc"
                :value="sc"
              >
                {{ sc }}
              </option>
            </select>
            <B24Button
              color="air-primary"
              label="Скачать журнал"
              :loading="busy"
              data-testid="spy-download"
              @click="downloadJournal"
            />
            <B24Button
              color="air-secondary"
              label="Очистить журнал"
              :loading="busy"
              data-testid="spy-journal-clear"
              @click="clearJournal"
            />
          </div>
        </B24Card>

        <B24Card>
          <template #header>
            <div class="flex items-center justify-between gap-2">
              <h2 class="font-semibold">
                Пойманные запросы ({{ state.captures.length }})
              </h2>
              <div class="flex gap-2">
                <B24Button
                  color="air-secondary"
                  label="Обновить"
                  :loading="busy"
                  data-testid="spy-refresh"
                  @click="run(async () => {})"
                />
                <B24Button
                  color="air-secondary"
                  label="Очистить"
                  :loading="busy"
                  data-testid="spy-clear"
                  @click="clearCaptures"
                />
              </div>
            </div>
          </template>
          <p
            v-if="!state.captures.length"
            class="text-sm opacity-70"
          >
            Пока пусто. Выберите «TEST …» в настройках BitrixGPT и сделайте запрос в портале.
          </p>
          <details
            v-for="(c, i) in state.captures"
            :key="c.id ?? `${c.at}-${c.category}`"
            class="border-t py-2"
            :data-testid="`spy-capture-${i}`"
          >
            <summary class="cursor-pointer text-sm">
              {{ c.at }} · <b>{{ c.category }}</b>{{ c.scenario ? ` · ${c.scenario}` : '' }} · {{ c.bodyBytes }} Б ·
              callback: {{ c.callback.target }}{{ c.callback.status ? ` → ${c.callback.status}` : '' }}{{ c.callback.error ? ` (${c.callback.error})` : '' }}
            </summary>
            <p class="text-xs mt-1">
              Ключи: <span class="font-mono">{{ c.keys.join(', ') }}</span> · Content-Type: <span class="font-mono">{{ c.contentType || '—' }}</span>
            </p>
            <B24Button
              v-if="state.full && c.journalId && !fullText[c.journalId]"
              class="mt-1"
              color="air-secondary"
              size="sm"
              label="Показать полностью"
              :loading="busy"
              :data-testid="`spy-capture-full-${i}`"
              @click="showFull(c.journalId)"
            />
            <pre
              v-if="c.journalId && fullText[c.journalId]"
              class="text-xs whitespace-pre-wrap break-all mt-1 max-h-[32rem] overflow-auto"
            >{{ JSON.stringify(fullText[c.journalId], null, 2) }}</pre>
            <pre
              v-else
              class="text-xs whitespace-pre-wrap break-all mt-1"
            >{{ JSON.stringify(c.body, null, 2) }}</pre>
          </details>
        </B24Card>
      </template>
    </div>
  </InPortalGate>
</template>
