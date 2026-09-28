// Бюджет места в app.option. ТЗ: «ограничение на место есть — уточнить, сколько влезет, и
// ограничить с запасом 30 %». Что известно, что нет и как замерить — docs/SETTINGS.md,
// раздел «Сколько влезет».
//
// Что известно (2026-09-24):
// • документация REST (app.option.set, MCP b24-dev-mcp) размера не называет;
// • документация ядра `\Bitrix\Main\Config\Option::set` говорит: «Максимальная сохраняемая длина
//   значения — 2000 символов» (training.bitrix24.com/api_d7/bitrix/main/config/option/set.php).
//   Что app.option хранится именно так и ОДНИМ значением на все ключи — наша гипотеза, не замер.
// • Переполнение опасно всерьёз: обрезанная сериализация не читается целиком, и портал потерял
//   бы ВСЕ настройки приложения, а не только ставки.
//
// Поэтому по умолчанию — документированный предел, а настоящий замеряется из приложения
// (useStorageProbe.ts) и сохраняется ключом STORAGE_KEY; дальше бюджет считается от замера.

/** Предел из документации ядра (Option::set) — пока нет замера, считаем по нему. */
export const DOCUMENTED_OPTION_LIMIT = 2000
/** Запас по ТЗ. */
export const SAFETY_MARGIN = 0.3
/** Ключ app.option с результатом замера: `{"limit": байт, "at": "ГГГГ-ММ-ДД"}`. */
export const STORAGE_KEY = 'ift_storage_v1'
/** Рамки, в которых принимаем записанный замер: меньше документированного — мусор, больше 16 МБ — тоже. */
export const MIN_MEASURED_LIMIT = DOCUMENTED_OPTION_LIMIT
export const MAX_MEASURED_LIMIT = 16 * 1024 * 1024

/** Средний размер одной версии ставки в хранилище, байт: `[123,1500.5,"2026-01-01"],` ≈ 27. */
export const AVG_RATE_ENTRY_BYTES = 30

/** Длина строки в байтах UTF-8 — кириллица занимает 2 байта, и считать символы было бы ошибкой. */
export function utf8Length(value: string): number {
  return new TextEncoder().encode(value).length
}

/**
 * Длина PHP-сериализации ассоциативного массива строк — так портал, по нашей гипотезе,
 * хранит опции: `a:N:{s:3:"key";s:5:"value";…}`.
 */
export function phpSerializedLength(options: Record<string, string>): number {
  const entries = Object.entries(options)
  let total = `a:${entries.length}:{}`.length
  for (const [key, value] of entries) {
    const k = utf8Length(key)
    const v = utf8Length(value)
    total += `s:${k}:"";`.length + k + `s:${v}:"";`.length + v
  }
  return total
}

export interface MeasuredLimit {
  /** Наибольший размер всех опций (байт), который пережил запись и чтение без потерь. */
  limit: number
  /** Дата замера. */
  at: string
}

/** Разбор сохранённого замера; `null` — замера нет или он мусорный. */
export function parseMeasuredLimit(raw: unknown): MeasuredLimit | null {
  let data: unknown = raw
  if (typeof raw === 'string') {
    try {
      data = JSON.parse(raw)
    } catch {
      return null
    }
  }
  const o = (data && typeof data === 'object' ? data : {}) as Record<string, unknown>
  const limit = Number(o.limit)
  if (!Number.isInteger(limit) || limit < MIN_MEASURED_LIMIT || limit > MAX_MEASURED_LIMIT) return null
  return { limit, at: typeof o.at === 'string' ? o.at.slice(0, 10) : '' }
}

/** Действующий предел: замер, если он есть, иначе документированный. */
export function optionLimit(options: Record<string, string>): { limit: number, measured: MeasuredLimit | null } {
  const measured = parseMeasuredLimit(options[STORAGE_KEY])
  return { limit: measured?.limit ?? DOCUMENTED_OPTION_LIMIT, measured }
}

/** Бюджет — предел минус запас 30 %. */
export function budgetFor(limit: number): number {
  return Math.floor(limit * (1 - SAFETY_MARGIN))
}

export interface StorageUsage {
  /** Сколько байт займут опции после сохранения. */
  bytes: number
  /** Разрешённый бюджет. */
  budget: number
  /** Предел, от которого считается бюджет, и замерен ли он. */
  limit: number
  measured: boolean
  /** Доля занятого бюджета, 0…1+ (больше 1 — не влезает). */
  ratio: number
  fits: boolean
  /** Сколько ещё версий ставок примерно влезет. */
  rateCapacityLeft: number
}

/**
 * Сколько места займут опции приложения после сохранения.
 *
 * @param options ВСЕ ключи app.option с их будущими значениями — считать нужно целиком: ставки
 *   и настройки делят одно место (гипотеза выше), и проверка одного ключа пропустила бы
 *   переполнение, созданное другим
 */
export function storageUsage(options: Record<string, string>): StorageUsage {
  const { limit, measured } = optionLimit(options)
  const budget = budgetFor(limit)
  const bytes = phpSerializedLength(options)
  return {
    bytes,
    budget,
    limit,
    measured: measured !== null,
    ratio: budget > 0 ? bytes / budget : Infinity,
    fits: bytes <= budget,
    rateCapacityLeft: Math.max(0, Math.floor((budget - bytes) / AVG_RATE_ENTRY_BYTES))
  }
}

/**
 * Подпись для индикатора в настройках: «1,2 из 1,4 КБ». Без `toLocaleString`: его вывод зависит
 * от ICU среды (в урезанной сборке Node — «1.2»), а подпись должна быть одинаковой везде.
 */
export function formatUsage(usage: StorageUsage): string {
  const kb = (n: number) => (n / 1024).toFixed(1).replace('.', ',')
  return `${kb(usage.bytes)} из ${kb(usage.budget)} КБ`
}

/**
 * Ступени замера — суммарный размер всех опций, байт. Идём снизу вверх и останавливаемся на
 * первой неудаче; найденный предел — последняя удачная ступень (нижняя граница, то есть
 * ошибка в безопасную сторону). Верх — 256 КБ: при 30 байтах на ставку это ~6000 ставок,
 * больше приложению не нужно, а огромные запросы упираются уже в лимиты REST, а не хранилища.
 */
export const PROBE_LADDER = [1_500, 1_990, 2_010, 4_000, 8_000, 16_000, 32_000, 60_000, 65_000, 66_000, 131_000, 262_144] as const

/** Ключ, которым замер пишет пробные данные; после замера он остаётся пустой строкой. */
export const PROBE_KEY = 'ift_probe_tmp'

/**
 * Значение пробного ключа, при котором все опции займут `targetBytes`. `null` — ступень меньше
 * того, что уже занято, её пропускаем.
 */
export function probeFiller(backup: Record<string, string>, targetBytes: number): string | null {
  const base = phpSerializedLength({ ...backup, [PROBE_KEY]: '' })
  const extra = targetBytes - base
  if (extra <= 0) return null
  // Длина строки попадает в сериализацию дважды: как число в `s:N:` и как сами символы.
  // Подбираем N так, чтобы итог совпал с целью точно.
  let n = extra
  while (n > 0 && phpSerializedLength({ ...backup, [PROBE_KEY]: 'x'.repeat(n) }) > targetBytes) n--
  return n > 0 ? 'x'.repeat(n) : null
}
