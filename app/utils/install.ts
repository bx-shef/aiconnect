// Установка: какие вызовы сделать и чего не хватает. Чистые функции — порядок и состав
// вызовов проверяются тестом, а сама страница (pages/install.vue) лишь исполняет их.

import { B24_REQUIRED_SCOPES, BOUND_EVENTS, EVENTS_HANDLER_PATH, INVOICE_HANDLER_PATH, INVOICE_PLACEMENT, INVOICE_PLACEMENT_TITLE } from '~/config/b24'

/**
 * Адрес обработчика, пригодный для placement.bind / event.bind: только абсолютный https.
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
  method: 'placement.bind' | 'event.bind'
  params: Record<string, unknown>
}

/**
 * Регистрация пункта меню в карточке счёта — если его ещё нет. `existing` — ответ `placement.get`.
 * ⚠ Точка допускает несколько регистраций (документация «Каталог точек встраивания»), поэтому
 * повторный bind при переустановке дал бы ВТОРОЙ пункт меню, а не ошибку.
 */
export function placementBindCall(siteUrl: string, existing: unknown = []): BindCall | null {
  const handler = absoluteHandler(siteUrl, INVOICE_HANDLER_PATH)
  if (!handler) return null
  const already = (Array.isArray(existing) ? existing : [])
    .map(p => p as { placement?: unknown, handler?: unknown })
    .some(p => String(p.placement ?? '').toUpperCase() === INVOICE_PLACEMENT && String(p.handler ?? '') === handler)
  if (already) return null
  return {
    method: 'placement.bind',
    params: {
      PLACEMENT: INVOICE_PLACEMENT,
      HANDLER: handler,
      TITLE: INVOICE_PLACEMENT_TITLE,
      LANG_ALL: { ru: { TITLE: INVOICE_PLACEMENT_TITLE }, en: { TITLE: 'Fill from tasks' } }
    }
  }
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

/** Встройки нашего приложения, указывающие на СТАРЫЙ адрес (переезд сервера) — их снимаем. */
export function stalePlacements(siteUrl: string, existing: unknown): Array<{ PLACEMENT: string, HANDLER: string }> {
  const handler = absoluteHandler(siteUrl, INVOICE_HANDLER_PATH)
  if (!handler) return []
  return (Array.isArray(existing) ? existing : [])
    .map(p => p as { placement?: unknown, handler?: unknown })
    .filter(p => String(p.placement ?? '').toUpperCase() === INVOICE_PLACEMENT && String(p.handler ?? '') !== handler)
    .map(p => ({ PLACEMENT: INVOICE_PLACEMENT, HANDLER: String(p.handler ?? '') }))
}

/**
 * Подписки нашего приложения на события установки и удаления со СТАРЫМ адресом (переезд
 * сервера) — их снимаем `event.unbind` (`event`, `handler` — документация метода). Раньше
 * переустановка только дописывала новые подписки, и старые оставались мёртвым грузом (находка
 * ревьюера документации). `event.get` отдаёт подписки только нашего приложения.
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
