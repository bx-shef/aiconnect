// Итог записи строк в счёт — чистая функция: что сказать сотруднику и можно ли повторять.
// Запись в счёт — единственное необратимое действие приложения, поэтому решения здесь покрыты
// тестом (находка тестировщика и техдиректора панели).
//
// Исход определяется по ПЕРЕЧИТАННОМУ счёту, а не только по ответу портала: ответ может соврать
// в обе стороны. Портал мог выполнить запрос и не успеть ответить (таймаут), а пакет
// crm.item.productrow.add не транзакция — при ошибке посередине часть строк уже в счёте.

export type WriteMode = 'replace' | 'append'

export interface WriteReport {
  mode: WriteMode
  /** Сколько строк записывали. */
  planned: number
  /** Сколько позиций было в счёте до записи. */
  before: number
  /** Сколько позиций по перечитанному счёту; `null` — перечитать не удалось. */
  after: number | null
  /** Текст ошибки записи; `null` — портал ответил успехом. */
  error: string | null
}

export interface WriteVerdict {
  /** `done` — записано как задумано; `warn` — записано, но стоит проверить; `error` — отказ. */
  kind: 'done' | 'warn' | 'error'
  message: string
  /**
   * Сбросить собранные строки. Для «добавить» — после любого сбоя или расхождения: часть строк
   * могла уже попасть в счёт, и повтор задвоил бы их. «Заменить» повторять безопасно: набор
   * позиций заменяется целиком.
   */
  resetPreview: boolean
}

export function describeWrite(r: WriteReport): WriteVerdict {
  const check = 'Проверьте позиции в карточке счёта.'
  if (r.mode === 'replace') {
    if (r.error === null) {
      if (r.after === null) return { kind: 'warn', message: 'Строки записаны, но счёт не удалось перечитать — обновите карточку счёта.', resetPreview: false }
      if (r.after !== r.planned) return { kind: 'warn', message: `Портал принял запись, но позиций в счёте ${r.after}, а записывали ${r.planned}. ${check}`, resetPreview: false }
      return { kind: 'done', message: `Позиции счёта заменены: ${r.planned}.`, resetPreview: false }
    }
    const state = r.after === null ? 'Проверить, изменился ли счёт, не удалось.' : `Сейчас в счёте позиций: ${r.after}.`
    return { kind: 'error', message: `Портал ответил ошибкой: ${r.error}. ${state} Повторить «Заменить» безопасно — набор позиций заменится целиком.`, resetPreview: false }
  }

  const expected = r.before + r.planned
  if (r.error === null) {
    if (r.after === null) return { kind: 'warn', message: 'Строки добавлены, но счёт не удалось перечитать — обновите карточку счёта.', resetPreview: false }
    if (r.after !== expected) {
      return { kind: 'warn', message: `Портал принял ${r.planned} строк, но позиций в счёте стало ${r.after} вместо ${expected} — возможны дубли или чужие правки. ${check}`, resetPreview: true }
    }
    return { kind: 'done', message: `Добавлено строк: ${r.planned}.`, resetPreview: false }
  }
  // Ответ — ошибка, но в счёте уже все строки: портал выполнил пакет, а ответ потерялся (таймаут,
  // 5xx прокси). Это не сбой — и повторять «Добавить» нельзя, строки задвоятся (находка
  // /code-review: раньше здесь была «ошибка» с советом собрать строки заново).
  if (r.after !== null && r.after >= expected) {
    return { kind: 'warn', message: `Портал ответил ошибкой (${r.error}), но все ${r.planned} строк уже в счёте — повторять не нужно. ${check}`, resetPreview: true }
  }
  // Сразу после таймаута портал может ещё дописывать пакет: число — на момент проверки.
  const done = r.after === null
    ? `Сколько строк из ${r.planned} успело добавиться, проверить не удалось`
    : `На момент проверки добавлено ${Math.max(0, r.after - r.before)} из ${r.planned} строк`
  return { kind: 'error', message: `${done}, дальше — ошибка: ${r.error}. ${check} Чтобы не задвоить строки, соберите их заново.`, resetPreview: true }
}
