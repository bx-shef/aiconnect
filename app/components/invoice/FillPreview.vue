<script setup lang="ts">
// Предпросмотр строк счёта и проблем. Ничего не пишет — только показывает, что будет записано.
import type { DraftRow, FillIssue } from '#shared/domain/fill'
import type { PriceMode } from '#shared/domain/settings'
import { formatDuration, formatRuDate } from '#shared/domain/time'
import { netDrift, vatLabel, type VatRate, type VatTotals } from '#shared/domain/vat'

const props = defineProps<{
  rows: DraftRow[]
  errors: FillIssue[]
  warnings: FillIssue[]
  /** Итоги как их посчитает портал: без НДС, НДС, всего (vatTotals). */
  totals: VatTotals
  /** НДС счёта и чьи это «Реквизиты вашей компании». */
  vat: { rate: VatRate, company: string } | null
  /** Как строки лягут в счёт: цена часа и часы или сумма и 1. */
  priceMode: PriceMode
  /** Валюта счёта — в ней цены и суммы. */
  currency: string
  /** Валюта ставок; отличается от валюты счёта — колонка «Ставка» подписана ею (цены пересчитаны). */
  rateCurrency: string
  /** Адрес портала для ссылок на задачи (`https://portal.bitrix24.ru`). */
  origin: string
  userLabel: (id: number) => string
}>()

const money = (v: number) => v.toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const hours = (v: number) => v.toLocaleString('ru-RU', { maximumFractionDigits: 4 })
const markupLabel = (row: DraftRow) => row.markupSource === 'tag' ? `#${row.markupTag ?? ''}` : 'на всё'
const placement = computed(() => props.priceMode === 'sum'
  ? 'в счёт: цена — сумма строки, количество — 1'
  : 'в счёт: цена — цена часа, количество — часы')
const drift = computed(() => netDrift(props.rows.map(r => r.sum), props.totals))
const vatText = computed(() => props.vat ? `${vatLabel(props.vat.rate)} — реквизиты «${props.vat.company}»` : '')

function taskHref(taskId: number): string {
  return `${props.origin}/company/personal/user/0/tasks/task/view/${taskId}/`
}
</script>

<template>
  <div class="space-y-4">
    <B24Alert
      v-if="errors.length"
      color="air-primary-alert"
      title="Заполнить счёт нельзя — в задачах не хватает данных"
      data-testid="fill-errors"
    >
      <template #description>
        <ul class="list-disc pl-5 space-y-1">
          <li
            v-for="(issue, i) in errors"
            :key="i"
          >
            <a
              v-if="issue.taskId"
              :href="taskHref(issue.taskId)"
              target="_blank"
              rel="noopener"
              class="underline"
            >Задача #{{ issue.taskId }}</a><template v-if="issue.taskId">
              :
            </template>{{ issue.message }}
          </li>
        </ul>
      </template>
    </B24Alert>

    <B24Alert
      v-if="warnings.length"
      color="air-primary-warning"
      title="Обратите внимание"
    >
      <template #description>
        <ul class="list-disc pl-5">
          <li
            v-for="(issue, i) in warnings"
            :key="i"
          >
            <a
              v-if="issue.taskId"
              :href="taskHref(issue.taskId)"
              target="_blank"
              rel="noopener"
              class="underline"
            >Задача #{{ issue.taskId }}</a><template v-if="issue.taskId">
              :
            </template>{{ issue.message }}
          </li>
        </ul>
      </template>
    </B24Alert>

    <div
      v-if="rows.length"
      class="overflow-x-auto"
    >
      <p
        class="text-xs opacity-70 mb-2"
        data-testid="fill-placement"
      >
        Цены — без НДС, налог сверху; {{ placement }}
      </p>
      <table
        class="w-full text-sm"
        data-testid="fill-preview"
      >
        <thead>
          <tr class="text-left opacity-70">
            <th class="py-2 pr-3 font-medium">
              Название строки
            </th>
            <th class="py-2 pr-3 font-medium">
              Сотрудник
            </th>
            <th class="py-2 pr-3 font-medium text-right">
              Часы
            </th>
            <th class="py-2 pr-3 font-medium text-right">
              Ставка<template v-if="rateCurrency && rateCurrency !== currency">
                , {{ rateCurrency }}
              </template>
            </th>
            <th class="py-2 pr-3 font-medium text-right">
              Наценка
            </th>
            <th class="py-2 pr-3 font-medium text-right">
              Цена часа
            </th>
            <th class="py-2 font-medium text-right">
              Сумма без НДС
            </th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="row in rows"
            :key="row.key"
            class="align-top border-t border-(--ui-color-divider-less)"
          >
            <td class="py-2 pr-3">
              {{ row.name }}
              <a
                :href="taskHref(row.taskId)"
                target="_blank"
                rel="noopener"
                class="block text-xs opacity-60 underline"
              >задача #{{ row.taskId }}</a>
            </td>
            <td class="py-2 pr-3">
              {{ userLabel(row.userId) }}
            </td>
            <td
              class="py-2 pr-3 text-right whitespace-nowrap"
              :title="`Списано ${formatDuration(row.seconds)}, к оплате ${formatDuration(row.roundedSeconds)}`"
            >
              {{ hours(row.hours) }}
            </td>
            <td
              class="py-2 pr-3 text-right whitespace-nowrap"
              :title="`Ставка на ${formatRuDate(row.rateDate)}`"
            >
              {{ money(row.baseRate) }}
            </td>
            <td class="py-2 pr-3 text-right whitespace-nowrap">
              {{ row.markupPercent }}% <span class="opacity-60">({{ markupLabel(row) }})</span>
            </td>
            <td class="py-2 pr-3 text-right whitespace-nowrap">
              {{ money(row.hourPrice) }}
            </td>
            <td class="py-2 text-right whitespace-nowrap">
              {{ money(row.sum) }}
            </td>
          </tr>
        </tbody>
        <tfoot>
          <tr class="border-t border-(--ui-color-divider-less)">
            <td
              colspan="6"
              class="py-2 pr-3 text-right"
            >
              Без НДС
            </td>
            <td
              class="py-2 text-right whitespace-nowrap"
              data-testid="fill-net"
            >
              {{ money(totals.net) }}
            </td>
          </tr>
          <tr>
            <td
              colspan="6"
              class="py-1 pr-3 text-right"
              data-testid="fill-vat-label"
            >
              {{ vatText }}
            </td>
            <td
              class="py-1 text-right whitespace-nowrap"
              data-testid="fill-vat"
            >
              {{ money(totals.vat) }}
            </td>
          </tr>
          <tr class="font-medium">
            <td
              colspan="6"
              class="py-2 pr-3 text-right"
            >
              Итого
            </td>
            <td
              class="py-2 text-right whitespace-nowrap"
              data-testid="fill-total"
            >
              {{ money(totals.total) }} {{ currency }}
            </td>
          </tr>
        </tfoot>
      </table>
      <p
        v-if="drift"
        class="text-xs opacity-70 mt-1 text-right"
        data-testid="fill-drift"
      >
        Сумма строк без НДС — {{ money(totals.net + drift) }}: портал считает налог по каждой строке, а итог — одной
        суммой, поэтому «Без НДС» отличается на {{ money(Math.abs(drift)) }}. В счёте будут цифры как здесь внизу.
      </p>
    </div>
  </div>
</template>
