// Затраченное время: округление и перевод в часы. Чистые функции — их зовут и страница
// заполнения счёта, и тесты. Бизнес-правила — docs/PROCESSING.md, раздел «Время».

/**
 * Шаг округления в минутах. `0` — «как есть»: берём секунды без округления.
 * Закрытый список из ТЗ: как есть, час, 30, 10 и 5 минут.
 */
export const ROUNDING_STEPS = [0, 60, 30, 10, 5] as const

export type RoundingStep = typeof ROUNDING_STEPS[number]

/** Подписи шагов для интерфейса настроек — в одном месте со списком, чтобы не разъехались. */
export const ROUNDING_LABELS: Readonly<Record<RoundingStep, string>> = {
  0: 'Как есть (до секунды)',
  60: 'До часа',
  30: 'До 30 минут',
  10: 'До 10 минут',
  5: 'До 5 минут'
}

/**
 * Направление округления (решение владельца по #3: настройка, по умолчанию вверх).
 * • `up` — начатый шаг считается целиком: так выставляют время в счетах;
 * • `nearest` — к ближайшему, половина шага — вверх. Запись короче половины шага обнуляется.
 */
export const ROUNDING_DIRECTIONS = ['up', 'nearest'] as const

export type RoundingDirection = typeof ROUNDING_DIRECTIONS[number]

export const ROUNDING_DIRECTION_LABELS: Readonly<Record<RoundingDirection, string>> = {
  up: 'Вверх: начатый интервал — целиком',
  nearest: 'К ближайшему: короче половины шага — ноль'
}

/** Проверка направления для разбора сохранённых настроек. */
export function isRoundingDirection(value: unknown): value is RoundingDirection {
  return (ROUNDING_DIRECTIONS as readonly unknown[]).includes(value)
}

/** Сколько знаков после запятой несёт количество часов в строке счёта. */
export const HOURS_PRECISION = 4

/** Проверка, что значение — один из допустимых шагов (для разбора сохранённых настроек). */
export function isRoundingStep(value: unknown): value is RoundingStep {
  return (ROUNDING_STEPS as readonly unknown[]).includes(value)
}

/**
 * Округляет длительность до шага в заданном направлении.
 *
 * ⚠ По умолчанию — вверх («начатый час — час»). К ближайшему короткая запись (3 минуты при шаге
 * в час) становится нулём: строку с нулём часов сборка пропускает С ПРЕДУПРЕЖДЕНИЕМ (fill.ts),
 * чтобы работа не пропала из счёта молча. Правило — docs/PROCESSING.md, «Время».
 *
 * @param seconds длительность в секундах; отрицательное и нечисловое считаются нулём
 * @param step шаг в минутах, `0` — без округления
 * @param direction `up` — вверх, `nearest` — к ближайшему (половина — вверх)
 * @returns длительность в секундах, целая
 */
export function roundSeconds(seconds: number, step: RoundingStep, direction: RoundingDirection = 'up'): number {
  const s = Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds) : 0
  if (step === 0 || s === 0) return s
  const stepSeconds = step * 60
  const steps = direction === 'nearest' ? Math.round(s / stepSeconds) : Math.ceil(s / stepSeconds)
  return steps * stepSeconds
}

/**
 * Переводит секунды в часы для колонки «Количество».
 * Округляется до {@link HOURS_PRECISION} знаков — дальше Битрикс24 считает сумму строки сам.
 */
export function secondsToHours(seconds: number): number {
  const factor = 10 ** HOURS_PRECISION
  return Math.round((seconds / 3600) * factor) / factor
}

/**
 * Календарная дата записи времени в часовом поясе портала (`YYYY-MM-DD`).
 *
 * ⚠ Берём первые 10 символов ISO-строки, а НЕ `new Date(...)`: портал отдаёт время со своим
 * смещением (`2025-12-18T00:30:00+03:00`), и перевод в UTC перенёс бы запись на предыдущий
 * день — а по дате выбирается ставка. Дата — та, что видит сотрудник в своём портале.
 *
 * @returns дата или `null`, если строка не похожа на дату
 */
export function portalDate(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const head = value.trim().slice(0, 10)
  return isIsoDate(head) ? head : null
}

/** Строгая проверка `YYYY-MM-DD` с проверкой существования дня (31 февраля не пройдёт). */
export function isIsoDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const [y, m, d] = value.split('-').map(Number) as [number, number, number]
  const dt = new Date(Date.UTC(y, m - 1, d))
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d
}

/**
 * Дата для сообщений и предпросмотра так, как её видит сотрудник: `2026-09-01` → `01.09.2026`.
 * Не дата — строка как есть: сообщение об ошибке не должно само падать на мусоре.
 */
export function formatRuDate(iso: string): string {
  return isIsoDate(iso) ? iso.split('-').reverse().join('.') : iso
}

/** Человекочитаемая длительность для предпросмотра: `1 ч 05 мин`. */
export function formatDuration(seconds: number): string {
  const total = Math.max(0, Math.round(seconds))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  if (h === 0 && m === 0) return `${s} с`
  const mm = String(m).padStart(2, '0')
  return h > 0 ? `${h} ч ${mm} мин` : `${m} мин`
}
