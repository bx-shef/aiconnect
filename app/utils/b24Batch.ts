// Ошибки REST-вызовов и разбор ответа пакета — чистые функции без Nuxt и SDK, чтобы остановка
// пакета на ошибке проверялась тестом (находка программиста панели).

/** Ошибка REST-вызова с кодом метода — чтобы в интерфейсе было видно, ЧТО не получилось. */
export class B24CallError extends Error {
  constructor(readonly method: string, readonly messages: string[]) {
    super(`${method}: ${messages.join('; ') || 'неизвестная ошибка'}`)
    this.name = 'B24CallError'
  }
}

export type BatchCall = [method: string, params: Record<string, unknown>]

/** Срез ответа одной команды пакета (AjaxResult SDK), который мы читаем. */
export interface BatchItem<T> {
  isSuccess: boolean
  getData: () => { result?: T } | undefined
  getErrorMessages: () => string[]
}

/**
 * Результаты порции пакета по порядку команд. Ошибка команды — {@link B24CallError} с её
 * методом. Ответов МЕНЬШЕ, чем команд, — портал остановил пакет (`halt`): при `isHaltOnError`
 * SDK не кладёт невыполненные команды в ответ (так устроен разбор пакета в b24jssdk 2.2.0,
 * batch/processing/v2), и это тоже ошибка — дальше не идём.
 */
export function unwrapBatchPart<T>(items: ReadonlyArray<BatchItem<T>>, part: ReadonlyArray<BatchCall>): T[] {
  const out: T[] = []
  items.forEach((item, idx) => {
    if (!item.isSuccess) throw new B24CallError(part[idx]?.[0] ?? 'batch', item.getErrorMessages())
    out.push(item.getData()?.result as T)
  })
  if (items.length < part.length) throw new B24CallError(part[items.length]?.[0] ?? 'batch', ['пакет остановлен порталом'])
  return out
}
