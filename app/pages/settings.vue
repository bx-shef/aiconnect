<script setup lang="ts">
// Настройки приложения. Администратор видит всё; назначенный редактор ставок — только ставки;
// остальные сотрудники — объяснение, к кому обратиться. Права ещё раз проверяет сервер.
import type { TabsItem } from '@bitrix24/b24ui-nuxt'
import { parseSettings, settingsProblems, type AppSettings } from '#shared/domain/settings'
import { formatUsage } from '#shared/domain/storageBudget'

const b24 = useB24()
const app = useAppSettings()
const toast = useToast()

const draft = ref<AppSettings | null>(null)
const loadError = ref('')
const saving = ref(false)

const tabs = computed<TabsItem[]>(() => {
  const all: TabsItem[] = [
    { label: 'Общие', slot: 'general' as const, value: 'general' },
    { label: 'Ставки', slot: 'rates' as const, value: 'rates' },
    { label: 'Наценки', slot: 'markup' as const, value: 'markup' },
    { label: 'НДС', slot: 'vat' as const, value: 'vat' },
    { label: 'Промпты', slot: 'prompts' as const, value: 'prompts' },
    { label: 'Доступ', slot: 'access' as const, value: 'access' },
    { label: 'Хранилище', slot: 'storage' as const, value: 'storage' }
  ]
  return app.isAdmin.value ? all : all.filter(t => t.value === 'rates')
})

const usage = computed(() => (draft.value ? app.usageWith({ settings: draft.value }) : null))
const problems = computed(() => (draft.value ? settingsProblems(draft.value) : []))

onMounted(async () => {
  if (!await b24.init()) return
  b24.getOrThrow().parent.setTitle('Настройки: счёт из задач')
  try {
    await app.load()
    // parseSettings строит объект заново — это и есть глубокая копия для черновика.
    draft.value = parseSettings(app.settings.value)
  } catch (e) {
    loadError.value = e instanceof Error ? e.message : String(e)
  }
})

async function save() {
  if (!draft.value) return
  saving.value = true
  try {
    await app.saveSettings(draft.value)
    toast.add({ title: 'Настройки сохранены', color: 'air-primary-success' })
  } catch (e) {
    toast.add({ title: 'Не удалось сохранить настройки', description: e instanceof Error ? e.message : String(e), color: 'air-primary-alert' })
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <InPortalGate>
    <div class="p-4 sm:p-6 max-w-4xl mx-auto space-y-4 pb-28">
      <h1 class="text-xl font-semibold">
        Настройки
      </h1>

      <B24Alert
        v-if="loadError"
        color="air-primary-alert"
        title="Настройки не загрузились"
        :description="`${loadError}. Сохранение заблокировано, чтобы не затереть настройки портала.`"
      />

      <template v-else-if="draft && app.loaded.value">
        <B24Alert
          v-if="!app.isAdmin.value && !app.mayEditRates.value"
          color="air-primary-warning"
          title="Нет прав на настройки"
          description="Настройки меняет администратор портала; ставки — ещё и назначенные им сотрудники. Обратитесь к администратору."
        />
        <template v-else>
          <B24Alert
            v-if="app.isAdmin.value && problems.length"
            color="air-primary-warning"
            title="Заполнить счёт пока нельзя"
            :description="problems.join('; ')"
          />

          <B24Tabs
            :items="tabs"
            class="w-full"
            :unmount-on-hide="false"
          >
            <template #general>
              <SettingsGeneral
                v-model="draft"
                class="pt-4"
              />
            </template>
            <template #rates>
              <SettingsRates class="pt-4" />
            </template>
            <template #markup>
              <SettingsMarkup
                v-model="draft"
                class="pt-4"
              />
            </template>
            <template #vat>
              <SettingsVat
                v-model="draft"
                class="pt-4"
              />
            </template>
            <template #prompts>
              <SettingsPrompts
                v-model="draft"
                class="pt-4"
              />
            </template>
            <template #access>
              <SettingsAccess
                v-model="draft"
                class="pt-4"
              />
            </template>
            <template #storage>
              <SettingsStorage class="pt-4" />
            </template>
          </B24Tabs>

          <!-- Общая кнопка сохраняет всё, кроме ставок: у ставок своя кнопка и свои права. -->
          <div
            v-if="app.isAdmin.value"
            class="fixed inset-x-0 bottom-0 z-10 flex flex-wrap items-center justify-center gap-3 border-t py-3 px-3 bg-(--air-theme-bg-color) border-(--ui-color-divider-less)"
          >
            <B24Button
              color="air-primary"
              label="Сохранить настройки"
              :loading="saving"
              :disabled="saving || !usage?.fits"
              data-testid="settings-save"
              @click="save"
            />
            <span
              v-if="usage"
              class="text-sm"
              :class="usage.fits ? 'opacity-70' : 'text-(--ui-color-accent-main-alert)'"
            >
              Место: {{ formatUsage(usage) }}<template v-if="!usage.fits">
                — не влезает: сократите промпты или замерьте предел (вкладка «Хранилище»)
              </template>
            </span>
          </div>
        </template>
      </template>

      <div
        v-else
        class="space-y-3"
        aria-busy="true"
      >
        <B24Skeleton class="h-10 w-full" />
        <B24Skeleton class="h-40 w-full" />
      </div>
    </div>
  </InPortalGate>
</template>
