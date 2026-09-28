// REST тестового портала через вебхук — тем же b24jssdk, что и приложение (`B24Hook` вместо
// `B24Frame`). Ошибки — только метод и текст портала: адрес вебхука (секрет) в вывод не попадает.

import { B24Hook } from '@bitrix24/b24jssdk'

export interface Portal {
  /** REST v2: `result` ответа или ошибка «метод: текст портала». */
  call<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T>
}

/** Исключение SDK без адреса запроса: у сетевой ошибки в `cause`/`config` лежит URL с секретом. */
function safe(method: string, e: unknown): Error {
  const message = e instanceof Error ? e.message : String(e)
  return new Error(`${method}: ${message.replace(/https?:\/\/\S+/g, '<адрес скрыт>')}`)
}

export function connectPortal(hook: string): Portal {
  const b24 = B24Hook.fromWebhookUrl(hook)
  b24.offClientSideWarning()

  return {
    async call<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
      let res
      try {
        res = await b24.actions.v2.call.make({ method, params })
      } catch (e) {
        throw safe(method, e)
      }
      if (!res.isSuccess) throw new Error(`${method}: ${res.getErrorMessages().join('; ')}`)
      return (res.getData() as { result?: T } | undefined)?.result as T
    }
  }
}
