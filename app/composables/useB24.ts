// Связь с порталом из фрейма: инициализация B24Frame (@bitrix24/b24jssdk) и обёртка вызова.
// Одиночка на уровне модуля — как в эталоне client-bank-alfa-by (app/composables/useB24.ts).
//
// ⚠ Токен фрейма уходит и на НАШ сервер (useApi.ts), а SDK обновляет его только на пути своих
// запросов. Опции `keepAuthFresh` из документации в установленной версии 2.2.0 ещё нет (проверено
// по типам пакета), поэтому свежесть токена перед запросом к серверу обеспечивает useApi.ts.

import { initializeB24Frame, type B24Frame } from '@bitrix24/b24jssdk'
import { sdkRestrictionParams } from '~/config/b24'

/** Ошибка REST-вызова с кодом метода — чтобы в интерфейсе было видно, ЧТО не получилось. */
export class B24CallError extends Error {
  constructor(readonly method: string, readonly messages: string[]) {
    super(`${method}: ${messages.join('; ') || 'неизвестная ошибка'}`)
    this.name = 'B24CallError'
  }
}

let frame: B24Frame | undefined
let inFlight: Promise<B24Frame | undefined> | undefined

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

  return { ready, init, get, getOrThrow, call }
}
