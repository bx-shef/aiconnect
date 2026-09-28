// Связь с порталом из фрейма: инициализация B24Frame (@bitrix24/b24jssdk) и обёртки вызовов.
// Одиночка на уровне модуля — как в эталоне client-bank-alfa-by (app/composables/useB24.ts).
//
// ⚠ Токен фрейма уходит и на НАШ сервер (useApi.ts), а SDK обновляет его только на пути своих
// запросов. Опции `keepAuthFresh` из документации в установленной версии 2.2.0 ещё нет (проверено
// по типам пакета), поэтому свежесть токена перед запросом к серверу обеспечивает useApi.ts.

import { initializeB24Frame, type AjaxResult, type B24Frame, type Result } from '@bitrix24/b24jssdk'
import { sdkRestrictionParams } from '~/config/b24'
import { B24CallError, unwrapBatchPart, type BatchCall, type BatchItem } from '~/utils/b24Batch'

let frame: B24Frame | undefined
let inFlight: Promise<B24Frame | undefined> | undefined

/** Максимум команд в одном batch-запросе REST v2 (документация BatchV2.make). */
export const BATCH_MAX = 50

export function useB24() {
  const ready = useState('b24-ready', () => false)

  /**
   * Инициализирует фрейм. `undefined` — страница открыта не в портале (прямая ссылка, превью):
   * у такой страницы нет `window.name` с данными портала, и SDK отказал бы сразу.
   */
  async function init(): Promise<B24Frame | undefined> {
    if (frame) return frame
    if (inFlight) return inFlight
    if (typeof window === 'undefined' || !window.name) return undefined
    // Без автоповторов записи при сетевых сбоях — см. sdkRestrictionParams (config/b24.ts).
    inFlight = initializeB24Frame({ restrictionParams: sdkRestrictionParams() })
      .then((f) => {
        frame = f
        ready.value = true
        return f
      })
      .catch(() => undefined)
      .finally(() => {
        inFlight = undefined
      })
    return inFlight
  }

  function get(): B24Frame | undefined {
    return frame
  }

  function getOrThrow(): B24Frame {
    if (!frame) throw new Error('Приложение открыто не в Битрикс24')
    return frame
  }

  /** Один вызов REST v2: результат или {@link B24CallError}. */
  async function call<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const res = await getOrThrow().actions.v2.call.make({ method, params })
    if (!res.isSuccess) throw new B24CallError(method, res.getErrorMessages())
    return res.getData()?.result as T
  }

  /** Все страницы списочного метода (курсором по id — рекомендованный Битрикс24 способ). */
  async function callList<T = unknown>(method: string, params: Record<string, unknown>, opts: { idKey?: string, cursorIdKey?: string, customKeyForResult?: string } = {}): Promise<T[]> {
    const res = await getOrThrow().actions.v2.callList.make<T>({ method, params, ...opts })
    if (!res.isSuccess) throw new B24CallError(method, res.getErrorMessages())
    return res.getData() ?? []
  }

  /**
   * Пачка вызовов REST v2 порциями по {@link BATCH_MAX} команд. Возвращает результат каждой
   * команды по порядку; первая же ошибка — исключение с методом и текстом портала (частичный
   * результат нам не нужен).
   *
   * `haltOnError` — портал прекращает выполнять команды пакета после первой ошибки, а следующие
   * порции не отправляются. Нужен для ЗАПИСИ: без него ошибка в середине не мешала бы порталу
   * выполнить остальные команды порции (`isHaltOnError: false`).
   */
  async function batch<T = unknown>(calls: BatchCall[], opts: { haltOnError?: boolean } = {}): Promise<T[]> {
    const out: T[] = []
    for (let i = 0; i < calls.length; i += BATCH_MAX) {
      const part = calls.slice(i, i + BATCH_MAX)
      const res = await getOrThrow().actions.v2.batch.make({
        calls: part,
        options: { isHaltOnError: opts.haltOnError ?? false, returnAjaxResult: true }
      }) as Result<AjaxResult<T>[]>
      const data = res.getData()
      const items = (Array.isArray(data) ? data : []) as unknown as BatchItem<T>[]
      if (!res.isSuccess) {
        // SDK помечает неуспешным весь пакет, если упала хоть одна команда, но ответы команд
        // оставляет: сначала называем упавшую команду (её метод и текст портала), и только если
        // таких нет — ошибку пакета целиком.
        unwrapBatchPart(items, part)
        throw new B24CallError('batch', res.getErrorMessages())
      }
      // Ошибка команды или остановка пакета порталом — исключение (b24Batch.ts, покрыт тестом).
      out.push(...unwrapBatchPart(items, part))
    }
    return out
  }

  /**
   * Один вызов REST v3 (`/rest/api/…`). Владелец: «если можем — берём REST v3»; сейчас в v3 есть
   * только методы задач (docs/REST_METHODS.md, «REST v3»). Фильтр — массив троек
   * `[поле, оператор, значение]`, связанные объекты — через точку в `select`.
   */
  async function callV3<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const res = await getOrThrow().actions.v3.call.make<T>({ method, params })
    if (!res.isSuccess) throw new B24CallError(method, res.getErrorMessages())
    return res.getData()?.result as T
  }

  return { ready, init, get, getOrThrow, call, callList, batch, callV3 }
}
