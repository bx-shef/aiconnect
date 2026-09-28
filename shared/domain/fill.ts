// Сборка строк товарной части счёта из задач. Чистая функция: на входе задачи, записи
// времени, ставки и настройки — на выходе строки и список проблем. Никаких REST-вызовов:
// их делает composable страницы (app/composables/useInvoiceFill.ts).
//
// Правила (ТЗ + решения владельца по #3, записанные в docs/PROCESSING.md):
// • тип 1 «задача» — одна строка на задачу; всё время задачи (всех участников) умножается на
//   ставку ОТВЕТСТВЕННОГО, действующую на дату последней записи времени; если за период задачи
//   ставка менялась — предупреждение;
// • тип 2 «время» — одна строка на запись времени; ставка того, кто списал время, на дату записи;
// • дата записи — дата её создания (tasks.ts);
// • наценка — по тегам задачи, первое совпадение, иначе «на всё» (markup.ts);
// • валюта счёта ≠ валюте ставок — цены пересчитываются по курсу портала (currency.ts);
// • в счёт — цена часа и часы или сумма строки и 1 (настройка priceMode);
// • цена — без НДС, налог сверху по «Реквизитам вашей компании» счёта (vat.ts);
// • если чего-то не хватает — ошибка, и НИЧЕГО не пишется (ТЗ: «стоп работа и показ ошибки»).
//   Ошибки собираются все сразу, чтобы человек исправил задачи за один проход.

import type { CurrencyConversion } from './currency'
import { applyMarkup, resolveMarkup, type MarkupSource } from './markup'
import { findRate, type RateEntry } from './rates'
import type { AppSettings, PriceMode } from './settings'
import type { TaskInfo, TimeEntry } from './tasks'
import { formatDuration, formatRuDate, roundSeconds, secondsToHours } from './time'
import { roundMoney } from './money'
import { grossPrice, type VatRate } from './vat'

/** Тип заполнения: 1 — задача как учётная единица, 2 — записи затраченного времени. */
export type FillMode = 'task' | 'time'
/** Откуда брать задачи. Смешивать источники нельзя (ТЗ). */
export type TaskSource = 'deal' | 'invoice'

/** Длина названия товара в строке — у поля товарной позиции предел 255 символов. */
export const MAX_ROW_NAME = 255

export interface FillInput {
  mode: FillMode
  /** Задачи; теги (`tags`) нужны, только если в настройках есть правила наценки по тегам. */
  tasks: TaskInfo[]
  entries: TimeEntry[]
  rates: RateEntry[]
  settings: AppSettings
  /** Пересчёт в валюту счёта; `null`/нет — валюты совпадают. */
  conversion?: CurrencyConversion | null
  /** Ставка НДС счёта (vatForInvoice); `null` — «Без НДС». */
  vatRate: VatRate
  /** Имена сотрудников для понятных сообщений; нет имени — пишем `#ID`. */
  userNames?: Map<number, string>
}

export interface DraftRow {
  /** Ключ строки: `t<taskId>` (тип 1) или `e<entryId>` (тип 2). По нему приходят имена от BitrixGPT. */
  key: string
  taskId: number
  entryId?: number
  userId: number
  name: string
  /** Исходная длительность и после округления, секунды. */
  seconds: number
  roundedSeconds: number
  /** Часы после округления. */
  hours: number
  /** Ставка без наценки в валюте ставок и дата, на которую она выбрана. */
  baseRate: number
  rateDate: string
  markupPercent: number
  markupSource: MarkupSource
  /** Тег сработавшего правила наценки (`markupSource = 'tag'`). */
  markupTag?: string
  /** Цена часа с наценкой в валюте счёта, без НДС. */
  hourPrice: number
  /**
   * Что уходит в строку счёта (priceMode): `hour` — цена часа и часы, `sum` — сумма строки и 1.
   * Цена — без НДС: налог добавляет toProductRows.
   */
  price: number
  quantity: number
  /** Сумма строки без НДС для предпросмотра (портал считает её сам). */
  sum: number
  /** Ставка НДС строки — одна на счёт; `null` — «Без НДС». */
  taxRate: VatRate
}

export interface FillIssue {
  /** Задача, к которой относится проблема; `0` — к счёту целиком (валюта, «нет задач»). */
  taskId: number
  entryId?: number
  message: string
}

export interface FillResult {
  rows: DraftRow[]
  /** Режим, которым собраны строки, — подпись предпросмотра берёт его, а не текущие настройки. */
  priceMode: PriceMode
  errors: FillIssue[]
  /** Не мешают записи, но о них стоит знать (пересчёт валюты, смена ставки, пропуски). */
  warnings: FillIssue[]
}

function userLabel(input: FillInput, userId: number): string {
  return input.userNames?.get(userId) ?? `#${userId}`
}

/** Обрезка названия до предела поля с многоточием; пробелы по краям и переводы строк убираем. */
export function clampName(name: string): string {
  const flat = name.replace(/\s+/g, ' ').trim()
  return flat.length > MAX_ROW_NAME ? `${flat.slice(0, MAX_ROW_NAME - 1)}…` : flat
}

/**
 * Цена часа: ставка → пересчёт в валюту счёта → наценка по тегам задачи. Округление до копеек —
 * один раз, в конце (applyMarkup): двойное округление давало бы расхождение на копейки.
 */
function priceFor(input: FillInput, task: TaskInfo, rate: RateEntry): Pick<DraftRow, 'markupPercent' | 'markupSource' | 'markupTag' | 'price'> {
  const markup = resolveMarkup(input.settings.markup, task.tags)
  return {
    markupPercent: markup.percent,
    markupSource: markup.source,
    ...(markup.tag ? { markupTag: markup.tag } : {}),
    price: applyMarkup(rate.rate * (input.conversion?.factor ?? 1), markup.percent)
  }
}

function rateLabel(rate: RateEntry | null): string {
  return rate ? `${rate.rate} с ${formatRuDate(rate.from)}` : 'нет ставки'
}

/**
 * Менялась ли ставка ответственного за период задачи (тип 1, решение владельца по #3: берём
 * ставку на последнюю запись, но сообщаем о смене). Сравниваются версии ставки на даты всех
 * записей со временем; «нет ставки» на ранние даты — тоже смена.
 */
function rateChangeWarning(input: FillInput, userId: number, dates: string[], applied: RateEntry): string | null {
  const versions = new Map<string, RateEntry | null>()
  for (const date of dates) {
    const rate = findRate(input.rates, userId, date)
    versions.set(rate ? rate.from : '', rate)
  }
  if (versions.size < 2) return null
  const chain = [...versions.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, r]) => rateLabel(r))
  return `ставка ${userLabel(input, userId)} менялась за время задачи: ${chain.join(' → ')}; применена ${applied.rate} — на дату последней записи`
}

/**
 * Цена и количество строки по настройке priceMode. Сумма — от цены часа и часов в обоих режимах,
 * поэтому режим не меняет итог счёта (кроме копеек округления цены за всю строку в режиме `sum`).
 */
function placed(input: FillInput, hourPrice: number, hours: number): Pick<DraftRow, 'hourPrice' | 'price' | 'quantity' | 'sum' | 'taxRate'> {
  const sum = roundMoney(hourPrice * hours)
  return input.settings.priceMode === 'sum'
    ? { hourPrice, price: sum, quantity: 1, sum, taxRate: input.vatRate }
    : { hourPrice, price: hourPrice, quantity: hours, sum, taxRate: input.vatRate }
}

/** Ноль после округления возможен только «к ближайшему» — но текст от направления не зависит. */
function zeroAfterRounding(seconds: number): string {
  return `время ${formatDuration(seconds)} после округления стало нулём — строка пропущена`
}

function buildTaskRows(input: FillInput, result: FillResult): void {
  const { rounding: step, roundingDirection: direction } = input.settings
  for (const task of input.tasks) {
    const entries = input.entries.filter(e => e.taskId === task.id && e.seconds > 0)
    const total = entries.reduce((sum, e) => sum + e.seconds, 0)
    const problems: string[] = []
    if (!task.title) problems.push('у задачи нет названия')
    if (task.responsibleId === null) problems.push('у задачи нет ответственного')
    if (total === 0) {
      problems.push(task.timeSpentInLogs > 0
        ? 'журнал времени задачи не прочитан (нет доступа к записям времени?)'
        : 'в задаче нет затраченного времени')
    }
    const dates = [...new Set(entries.map(e => e.date).filter((d): d is string => !!d))].sort()
    const lastDate = dates.at(-1) ?? null
    if (total > 0 && !lastDate) problems.push('у записей времени нет даты — не на что выбрать ставку')
    let rate: RateEntry | null = null
    if (task.responsibleId !== null && lastDate) {
      rate = findRate(input.rates, task.responsibleId, lastDate)
      if (!rate) problems.push(`нет ставки для ${userLabel(input, task.responsibleId)} на ${formatRuDate(lastDate)}`)
    }
    if (problems.length || !rate || task.responsibleId === null || !lastDate) {
      for (const message of problems) result.errors.push({ taskId: task.id, message })
      continue
    }
    const changed = rateChangeWarning(input, task.responsibleId, dates, rate)
    if (changed) result.warnings.push({ taskId: task.id, message: changed })
    const rounded = roundSeconds(total, step, direction)
    if (rounded === 0) {
      result.warnings.push({ taskId: task.id, message: zeroAfterRounding(total) })
      continue
    }
    const hours = secondsToHours(rounded)
    const { price: hourPrice, ...markup } = priceFor(input, task, rate)
    result.rows.push({
      key: `t${task.id}`,
      taskId: task.id,
      userId: task.responsibleId,
      name: clampName(task.title),
      seconds: total,
      roundedSeconds: rounded,
      hours,
      baseRate: rate.rate,
      rateDate: lastDate,
      ...markup,
      ...placed(input, hourPrice, hours)
    })
  }
}

function buildTimeRows(input: FillInput, result: FillResult): void {
  const { rounding: step, roundingDirection: direction } = input.settings
  for (const task of input.tasks) {
    const entries = input.entries.filter(e => e.taskId === task.id)
    if (entries.length === 0) {
      result.errors.push({ taskId: task.id, message: task.timeSpentInLogs > 0
        ? 'журнал времени задачи не прочитан (нет доступа к записям времени?)'
        : 'в задаче нет записей затраченного времени' })
      continue
    }
    for (const entry of entries) {
      if (entry.seconds === 0) {
        result.warnings.push({ taskId: task.id, entryId: entry.id, message: 'запись времени нулевой длины пропущена' })
        continue
      }
      const problems: string[] = []
      if (!entry.comment) problems.push(`у записи времени ${formatDuration(entry.seconds)} нет описания — нечем назвать строку`)
      if (entry.userId === null) problems.push('у записи времени не указан сотрудник')
      if (!entry.date) problems.push('у записи времени нет даты')
      let rate: RateEntry | null = null
      if (entry.userId !== null && entry.date) {
        rate = findRate(input.rates, entry.userId, entry.date)
        if (!rate) problems.push(`нет ставки для ${userLabel(input, entry.userId)} на ${formatRuDate(entry.date)}`)
      }
      if (problems.length || !rate || entry.userId === null || !entry.date) {
        for (const message of problems) result.errors.push({ taskId: task.id, entryId: entry.id, message })
        continue
      }
      const rounded = roundSeconds(entry.seconds, step, direction)
      if (rounded === 0) {
        result.warnings.push({ taskId: task.id, entryId: entry.id, message: zeroAfterRounding(entry.seconds) })
        continue
      }
      const hours = secondsToHours(rounded)
      const { price: hourPrice, ...markup } = priceFor(input, task, rate)
      result.rows.push({
        key: `e${entry.id}`,
        taskId: task.id,
        entryId: entry.id,
        userId: entry.userId,
        name: clampName(entry.comment),
        seconds: entry.seconds,
        roundedSeconds: rounded,
        hours,
        baseRate: rate.rate,
        rateDate: entry.date,
        ...markup,
        ...placed(input, hourPrice, hours)
      })
    }
  }
}

/**
 * Собирает строки счёта. Если `errors` не пуст — писать в счёт нельзя, даже частично.
 */
export function buildRows(input: FillInput): FillResult {
  const result: FillResult = { rows: [], priceMode: input.settings.priceMode, errors: [], warnings: [] }
  if (input.tasks.length === 0) {
    result.errors.push({ taskId: 0, message: 'не найдено ни одной задачи' })
    return result
  }
  if (input.mode === 'task') buildTaskRows(input, result)
  else buildTimeRows(input, result)
  // Пересчёт валюты — первым предупреждением: он касается каждой цены в счёте.
  if (input.conversion && result.rows.length) result.warnings.unshift({ taskId: 0, message: input.conversion.notice })
  return result
}

/**
 * Подставляет названия от BitrixGPT. Строка без названия — ошибка, а не тихий откат к
 * исходному тексту: человек выбрал режим ИИ и должен узнать, что он не сработал.
 */
export function applyNames(rows: DraftRow[], names: Record<string, string>): { rows: DraftRow[], errors: FillIssue[] } {
  const errors: FillIssue[] = []
  const out = rows.map((row) => {
    const name = clampName(typeof names[row.key] === 'string' ? names[row.key]! : '')
    if (!name) {
      errors.push({ taskId: row.taskId, ...(row.entryId ? { entryId: row.entryId } : {}), message: 'BitrixGPT не вернул название строки' })
      return row
    }
    return { ...row, name }
  })
  return { rows: out, errors }
}

/**
 * Строка в формате crm.item.productrow.set / .add (поля — по документации метода). Товара
 * каталога нет (#3): позиция — свободная, с названием, ценой и количеством. `price` — цена С
 * налогом (документация: «с учетом скидок и налогов»); `taxIncluded: 'N'` — НДС сверху, портал
 * покажет цену без НДС и налог отдельно. «Без НДС» — налоговых полей нет (портал ставит `taxRate: null`).
 */
export interface ProductRowPayload {
  productName: string
  price: number
  quantity: number
  taxRate?: number
  taxIncluded?: 'N'
  measureCode?: number
  sort: number
}

/** Перевод строк в поля товарных позиций. `sortStart` — чтобы в режиме «добавить» идти после существующих. */
export function toProductRows(rows: DraftRow[], settings: AppSettings, sortStart = 0): ProductRowPayload[] {
  return rows.map((row, i) => ({
    productName: row.name,
    price: grossPrice(row.price, row.taxRate),
    quantity: row.quantity,
    ...(row.taxRate === null ? {} : { taxRate: row.taxRate, taxIncluded: 'N' as const }),
    ...(settings.measureCode ? { measureCode: settings.measureCode } : {}),
    sort: sortStart + (i + 1) * 10
  }))
}
