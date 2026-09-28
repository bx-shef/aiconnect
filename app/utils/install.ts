// Installation: which calls to make and what's missing. Pure functions — the order and
// composition of calls are covered by tests, while the page itself (pages/install.vue) just runs them.

import { B24_REQUIRED_SCOPES, BOUND_EVENTS, EVENTS_HANDLER_PATH } from '~/config/b24'

/**
 * A handler address suitable for event.bind: absolute https only.
 * Bitrix24 won't accept a relative one, and the browser will reject http inside the portal frame.
 */
export function absoluteHandler(siteUrl: string, path: string): string | null {
  try {
    const url = new URL(path, siteUrl)
    return url.protocol === 'https:' ? url.toString() : null
  } catch {
    return null
  }
}

/** Which scopes the app is missing (response of the `scope` method — an array of strings). */
export function missingScopes(granted: unknown): string[] {
  const have = new Set(Array.isArray(granted) ? granted.map(String) : [])
  return B24_REQUIRED_SCOPES.filter(s => !have.has(s))
}

export interface BindCall {
  method: 'event.bind'
  params: Record<string, unknown>
}

/**
 * Event subscriptions that don't exist yet. `existing` is the `event.get` response: a repeat
 * install must not create duplicates or fail with "already subscribed".
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
 * Our app's install/uninstall event subscriptions with the OLD address (a server move) —
 * we remove them via `event.unbind` (`event`, `handler` — method docs): otherwise a reinstall
 * would only append new subscriptions, leaving the old ones as dead weight.
 * `event.get` returns only our app's subscriptions.
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
