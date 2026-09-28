<script setup lang="ts">
// Общие настройки: округление (шаг и направление), валюта ставок, как строка ложится в счёт,
// источник названий строк, единица измерения.
import { ROUNDING_DIRECTION_LABELS, ROUNDING_DIRECTIONS, ROUNDING_LABELS, ROUNDING_STEPS } from '#shared/domain/time'
import type { AppSettings } from '#shared/domain/settings'

const settings = defineModel<AppSettings>({ required: true })

const b24 = useB24()
const catalog = useCatalog()

const roundingItems = ROUNDING_STEPS.map(step => ({ label: ROUNDING_LABELS[step], value: step }))
const directionItems = ROUNDING_DIRECTIONS.map(direction => ({ label: ROUNDING_DIRECTION_LABELS[direction], value: direction }))
const namingItems = [
  { label: 'Как есть из задачи', value: 'plain', description: 'Тип 1 — заголовок задачи, тип 2 — описание записи времени' },
  { label: 'Через BitrixGPT', value: 'ai', description: 'Короткое понятное клиенту название по заголовку, описанию и отчёту' }
]
const priceModeItems = [
  { label: 'Цена часа × часы', value: 'hour', description: 'Цена — ставка часа с наценкой, количество — часы' },
  { label: 'Сумма строки × 1', value: 'sum', description: 'Цена — ставка часа с наценкой × часы, количество — 1' }
]
/** Код ОКЕИ «час»: при количестве 1 он читался бы как «1 час» за всю работу. */
const HOUR_MEASURE = 356
const measureHint = computed(() => settings.value.priceMode === 'sum'
  ? 'Количество в строке — 1: выберите единицу вроде «услуга» или «шт»'
  : 'Например, «час». Не выбрано — портал поставит единицу по умолчанию')
const currencies = ref<Array<{ label: string, value: string }>>([])
const measures = ref<Array<{ label: string, value: number }>>([])

onMounted(async () => {
  try {
    const list = await b24.call<Array<{ CURRENCY?: unknown, FULL_NAME?: unknown }>>('crm.currency.list')
    currencies.value = (list ?? []).map(c => ({ label: `${c.CURRENCY} — ${c.FULL_NAME ?? ''}`, value: String(c.CURRENCY ?? '') })).filter(c => c.value)
  } catch {
    currencies.value = settings.value.currency ? [{ label: settings.value.currency, value: settings.value.currency }] : []
  }
  try {
    measures.value = (await catalog.measures()).map(m => ({ label: m.label, value: m.code }))
  } catch {
    measures.value = []
  }
})

const measureModel = computed({
  get: () => settings.value.measureCode ?? 0,
  set: (v: number) => { settings.value.measureCode = v > 0 ? v : null }
})
</script>

<template>
  <div class="space-y-5">
    <B24FormField
      label="Округление затраченного времени"
      description="Тип 1 округляет время задачи целиком, тип 2 — каждую запись"
    >
      <div class="flex flex-wrap gap-3">
        <B24Select
          v-model="settings.rounding"
          :items="roundingItems"
          value-key="value"
          class="w-56"
          data-testid="settings-rounding"
        />
        <B24Select
          v-model="settings.roundingDirection"
          :items="directionItems"
          value-key="value"
          class="w-96"
          :disabled="settings.rounding === 0"
          aria-label="Направление округления"
          data-testid="settings-rounding-direction"
        />
      </div>
    </B24FormField>

    <B24FormField
      label="Валюта ставок"
      description="Счёт в другой валюте пересчитывается по курсу из справочника валют CRM — с предупреждением проверить курс"
      required
    >
      <B24Select
        v-model="settings.currency"
        :items="currencies"
        value-key="value"
        placeholder="Выберите валюту"
        class="w-72"
        data-testid="settings-currency"
      />
    </B24FormField>

    <B24FormField
      label="Как строка ложится в счёт"
      description="Цена всегда без НДС — налог добавляется сверху по «Реквизитам вашей компании» (вкладка «НДС»)"
    >
      <B24RadioGroup
        v-model="settings.priceMode"
        :items="priceModeItems"
        value-key="value"
        data-testid="settings-price-mode"
      />
    </B24FormField>

    <B24FormField label="Название строки счёта">
      <B24RadioGroup
        v-model="settings.naming"
        :items="namingItems"
        value-key="value"
        data-testid="settings-naming"
      />
    </B24FormField>

    <B24FormField
      label="Единица измерения строк"
      :description="measureHint"
    >
      <B24Select
        v-model="measureModel"
        :items="[{ label: 'Не задавать', value: 0 }, ...measures]"
        value-key="value"
        class="w-72"
      />
      <p
        v-if="settings.priceMode === 'sum' && settings.measureCode === HOUR_MEASURE"
        class="mt-1 text-sm text-(--ui-color-accent-main-warning)"
        data-testid="settings-measure-warning"
      >
        В режиме «Сумма строки × 1» единица «час» покажет в счёте «1 час» за всю работу
      </p>
    </B24FormField>
  </div>
</template>
