// REST тестового портала через вебхук — тем же b24jssdk, что и приложение (`B24Hook` вместо
// `B24Frame`). Ошибки — только метод и текст портала: адрес вебхука (секрет) в вывод не попадает.

import { B24Hook } from '@bitrix24/b24jssdk'

export interface BatchAnswer {
  ok: boolean
  result: unknown
  errors: string[]
}

export interface Portal {
  /** REST v2: `result` ответа или ошибка «метод: текст портала». */
  call<T = unknown>(method: string, params?: Record<string, unknown> | unknown[]): Promise<T>
  /** REST v3 (`/rest/api/…`). */
  callV3<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T>
  /** Все страницы списка курсором (как `useB24.callList`). */
  callList<T = unknown>(method: string, params: Record<string, unknown>, opts: { idKey: string, cursorIdKey: string, customKeyForResult: string }): Promise<T[]>
  /** Пакет v2 до 50 команд: ответ каждой команды, что вернул портал (с `halt` — меньше, чем команд). */
  batch(calls: Array<[string, Record<string, unknown> | unknown[]]>, haltOnError: boolean): Promise<{ ok: boolean, errors: string[], answers: BatchAnswer[] }>
}

interface AjaxLike {
  isSuccess: boolean
  getData: () => unknown
  getErrorMessages: () => string[]
}

function answer(r: AjaxLike): BatchAnswer {
  const data = r.isSuccess ? r.getData() as { result?: unknown } | undefined : undefined
  return { ok: r.isSuccess, result: data?.result, errors: r.isSuccess ? [] : r.getErrorMessages() }
}

/** Исключение SDK без адреса запроса: у сетевой ошибки в `cause`/`config` лежит URL с секретом. */
function safe(method: string, e: unknown): Error {
  const message = e instanceof Error ? e.message : String(e)
  return new Error(`${method}: ${message.replace(/https?:\/\/\S+/g, '<адрес скрыт>')}`)
}

export function connectPortal(hook: string): Portal {
  const b24 = B24Hook.fromWebhookUrl(hook)
  b24.offClientSideWarning()

  async function unwrap<T>(method: string, run: () => Promise<AjaxLike>): Promise<T> {
    let res: AjaxLike
    try {
      res = await run()
    } catch (e) {
      throw safe(method, e)
    }
    if (!res.isSuccess) throw new Error(`${method}: ${res.getErrorMessages().join('; ')}`)
    return (res.getData() as { result?: T } | undefined)?.result as T
  }

  return {
    call: (method, params = {}) => unwrap(method, () => b24.actions.v2.call.make({ method, params: params as Record<string, unknown> })),
    callV3: (method, params = {}) => unwrap(method, () => b24.actions.v3.call.make({ method, params })),
    async callList<T>(method: string, params: Record<string, unknown>, opts: { idKey: string, cursorIdKey: string, customKeyForResult: string }) {
      let res
      try {
        res = await b24.actions.v2.callList.make<T>({ method, params, ...opts })
      } catch (e) {
        throw safe(method, e)
      }
      if (!res.isSuccess) throw new Error(`${method}: ${res.getErrorMessages().join('; ')}`)
      return res.getData() ?? []
    },
    async batch(calls, haltOnError) {
      let res: AjaxLike
      try {
        res = await b24.actions.v2.batch.make({
          calls: calls as Array<[string, Record<string, unknown>]>,
          options: { isHaltOnError: haltOnError, returnAjaxResult: true }
        }) as AjaxLike
      } catch (e) {
        throw safe('batch', e)
      }
      const data = res.getData()
      return { ok: res.isSuccess, errors: res.getErrorMessages(), answers: (Array.isArray(data) ? data as AjaxLike[] : []).map(answer) }
    }
  }
}
