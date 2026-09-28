// Установка: какие вызовы сделать и чего не хватает. Чистые функции — порядок и состав
// вызовов проверяются тестом, а сама страница (pages/install.vue) лишь исполняет их.

import { B24_REQUIRED_SCOPES, BOUND_EVENTS, EVENTS_HANDLER_PATH } from '~/config/b24'

/**
 * Адрес обработчика, пригодный для event.bind: только абсолютный https.
 * Относительный Битрикс24 не примет, а http отвергнет браузер во фрейме портала.
 */
export function absoluteHandler(siteUrl: string, path: string): string | null {
  try {
    const url = new URL(path, siteUrl)
    return url.protocol === 'https:' ? url.toString() : null
  } catch {
    return null
  }
}

/** Каких прав не хватает приложению (ответ метода `scope` — массив строк). */
export function missingScopes(granted: unknown): string[] {
  const have = new Set(Array.isArray(granted) ? granted.map(String) : [])
  return B24_REQUIRED_SCOPES.filter(s => !have.has(s))
}

export interface BindCall {
  method: 'event.bind'
  params: Record<string, unknown>
}

/**
 * Подписки на события, которых ещё нет. `existing` — ответ `event.get`: повторная установка
 * не должна плодить дубли и падать на «уже подписан».
 */
export function eventBindCalls(siteUrl: string, existing: unknown): BindCall[] {
  const handler = absoluteHandler(siteUrl, EVENTS_HANDLER_PATH)
  if (!handler) return []
  const bound = new Set(
    (Array.isArray(existing) ? existing : [])
      .map(e => e as { event?: unknown, handler?: unknown })
      .filter(e => String(e.handler ?? '') === handler)
      .map(e => String(e.event ?? '').toUpperCase())
  )
  return BOUND_EVENTS.filter(ev => !bound.has(ev)).map(ev => ({ method: 'event.bind' as const, params: { event: ev, handler } }))
}

/**
 * Подписки нашего приложения на события установки и удаления со СТАРЫМ адресом (переезд
 * сервера) — их снимаем `event.unbind` (`event`, `handler` — документация метода): иначе
 * переустановка только дописывала бы новые подписки, и старые оставались мёртвым грузом.
 * `event.get` отдаёт подписки только нашего приложения.
 */
export function staleEventHandlers(siteUrl: string, existing: unknown): Array<{ event: string, handler: string }> {
  const handler = absoluteHandler(siteUrl, EVENTS_HANDLER_PATH)
  if (!handler) return []
  const ours = new Set<string>(BOUND_EVENTS)
  return (Array.isArray(existing) ? existing : [])
    .map(e => e as { event?: unknown, handler?: unknown })
    .filter(e => ours.has(String(e.event ?? '').toUpperCase()) && String(e.handler ?? '') !== '' && String(e.handler) !== handler)
    .map(e => ({ event: String(e.event).toUpperCase(), handler: String(e.handler) }))
}
