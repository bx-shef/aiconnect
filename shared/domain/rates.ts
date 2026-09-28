// Ставки часа сотрудников: «сотрудник — ставка — начиная с даты». Хранятся в app.option
// отдельным ключом (docs/SETTINGS.md), поэтому формат хранения компактный — место ограничено.

import { isIsoDate } from './time'

/** Одна версия ставки сотрудника. Действует с даты `from` до следующей версии того же сотрудника. */
export interface RateEntry {
  /** ID сотрудника в портале. */
  userId: number
  /** Ставка за час в валюте ставок (настройка `currency`), без наценки. */
  rate: number
  /** Дата начала действия, `YYYY-MM-DD`, включительно. */
  from: string
}

/**
 * Кортеж хранения: `[userId, rate, from]`. Четвёртый элемент (товар каталога) был до #3 —
 * при разборе он молча отбрасывается, так что старые записи читаются без миграции.
 */
export type StoredRate = [number, number, string]

/** Верхняя граница ставки — защита от опечатки «лишний ноль» и от мусора в хранилище. */
export const MAX_RATE = 1_000_000

/** Сколько версий ставок принимаем максимум. Реальный предел — бюджет хранилища (storageBudget.ts). */
export const MAX_RATE_ENTRIES = 5000

function positiveInt(value: unknown): number | null {
  const n = Number(value)
  return Number.isInteger(n) && n > 0 ? n : null
}

/**
 * Денежное значение ставки: конечное, БОЛЬШЕ нуля, не больше {@link MAX_RATE}, 2 знака.
 *
 * ⚠ Ноль — не ставка. Новая строка в таблице ставок начинается с 0, и пустое поле тоже даёт 0:
 * пропусти такую строку проверка — сотрудник молча выставлялся бы в счёт бесплатно, вместо
 * ошибки «нет ставки» (находка /code-review этого PR).
 */
export function normalizeRate(value: unknown): number | null {
  const n = toNumber(value)
  if (!Number.isFinite(n) || n <= 0 || n > MAX_RATE) return null
  const rounded = Math.round(n * 100) / 100
  return rounded > 0 ? rounded : null
}

/** Число из ввода: строка может быть с запятой — так вводят дробную часть в русской раскладке. */
function toNumber(value: unknown): number {
  return typeof value === 'string' ? Number(value.replace(',', '.')) : Number(value)
}

/**
 * Записи ставок из тела запроса — только объекты; иначе `null` (400/422, а не падение на
 * `null.userId` в проверке — находка /code-review). Поля приводятся к числам тем же правилом,
 * что и в {@link normalizeRate} (запятая — десятичный разделитель: `"12,5"` не должно стать
 * `NaN` раньше проверки — находка программиста панели); допустимость проверяет `validateRates`.
 */
export function coerceRateEntries(raw: unknown): RateEntry[] | null {
  if (!Array.isArray(raw)) return null
  if (raw.some(item => !item || typeof item !== 'object' || Array.isArray(item))) return null
  return raw.map((item) => {
    const o = item as Record<string, unknown>
    return { userId: Number(o.userId), rate: toNumber(o.rate), from: String(o.from ?? '') }
  })
}

/**
 * Разбор ставок из хранилища. Никогда не бросает: хранилище — внешние данные, битая запись
 * отбрасывается, а не роняет экран. Дубли (сотрудник + дата) схлопываются: побеждает последняя.
 */
export function parseRates(raw: unknown): RateEntry[] {
  let data: unknown = raw
  if (typeof raw === 'string') {
    try {
      data = JSON.parse(raw)
    } catch {
      return []
    }
  }
  if (!Array.isArray(data)) return []
  const byKey = new Map<string, RateEntry>()
  for (const item of data.slice(0, MAX_RATE_ENTRIES)) {
    if (!Array.isArray(item)) continue
    const userId = positiveInt(item[0])
    const rate = normalizeRate(item[1])
    const from = item[2]
    if (userId === null || rate === null || !isIsoDate(from)) continue
    byKey.set(`${userId}|${from}`, { userId, rate, from })
  }
  return sortRates([...byKey.values()])
}

/** Порядок для хранения и показа: по сотруднику, затем по дате. Детерминирован — диффы читаемы. */
export function sortRates(entries: RateEntry[]): RateEntry[] {
  return [...entries].sort((a, b) => a.userId - b.userId || a.from.localeCompare(b.from))
}

/** Сериализация в компактный JSON. Порядок стабильный, лишних ключей нет. */
export function serializeRates(entries: RateEntry[]): string {
  const tuples: StoredRate[] = sortRates(entries).map(e => [e.userId, e.rate, e.from])
  return JSON.stringify(tuples)
}

/** Ошибка в строке таблицы ставок — для подсветки в форме. */
export interface RateIssue {
  index: number
  message: string
}

/**
 * Проверка ставок перед сохранением. Возвращает все проблемы сразу, а не первую:
 * человек правит таблицу один раз, а не по кругу.
 */
export function validateRates(entries: RateEntry[]): RateIssue[] {
  const issues: RateIssue[] = []
  const seen = new Map<string, number>()
  entries.forEach((e, index) => {
    if (positiveInt(e.userId) === null) issues.push({ index, message: 'Не выбран сотрудник' })
    if (normalizeRate(e.rate) === null) issues.push({ index, message: `Ставка должна быть больше 0 и не больше ${MAX_RATE}` })
    if (!isIsoDate(e.from)) issues.push({ index, message: 'Дата начала должна быть в формате ГГГГ-ММ-ДД' })
    const key = `${e.userId}|${e.from}`
    const prev = seen.get(key)
    if (prev !== undefined) issues.push({ index, message: `Дубль: у этого сотрудника уже есть ставка с этой даты (строка ${prev + 1})` })
    else seen.set(key, index)
  })
  if (entries.length > MAX_RATE_ENTRIES) {
    issues.push({ index: MAX_RATE_ENTRIES, message: `Не больше ${MAX_RATE_ENTRIES} версий ставок` })
  }
  return issues
}

/**
 * Ставка сотрудника, действующая на дату: версия с наибольшей `from`, не позже `date`.
 *
 * @param date `YYYY-MM-DD` в часовом поясе портала (см. `portalDate`)
 * @returns версия ставки или `null`, если на эту дату у сотрудника ставки нет
 */
export function findRate(entries: RateEntry[], userId: number, date: string): RateEntry | null {
  let best: RateEntry | null = null
  for (const e of entries) {
    if (e.userId !== userId || e.from > date) continue
    if (!best || e.from > best.from) best = e
  }
  return best
}
