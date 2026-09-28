// Bitrix24 integration constants: scopes, events, SDK settings. One place so that
// the install flow, docs (docs/B24_EVENTS.md, docs/REST_METHODS.md) and code stay in sync.

import type { RestrictionParams } from '@bitrix24/b24jssdk'

/**
 * App scopes — configured in the app's card on the portal.
 * `ai_admin` — `ai.engine.register` / `unregister` / `list` (method docs, "Scope: ai_admin");
 * `user_brief` — `user.current` and minimal employee data (article "Available Bitrix24
 * scopes"). `profile`, `scope`, `app.info` — "Scope: basic" in the docs; for `event.bind` /
 * `event.get` / `event.unbind` the MCP page doesn't name a scope — the template called them with the
 * same set without a separate scope (confirm by installing on a test portal). The install page checks
 * the list against the `scope` method and shows what's missing.
 */
export const B24_REQUIRED_SCOPES = ['ai_admin', 'user_brief'] as const

/** Events we subscribe to on install (handler — /api/b24/events). */
export const BOUND_EVENTS = ['ONAPPINSTALL', 'ONAPPUNINSTALL'] as const
export const EVENTS_HANDLER_PATH = '/api/b24/events'

/**
 * SDK settings for the whole frame (`initializeB24Frame`, useB24.ts): no automatic retries
 * on a network error, timeout, or 5xx response. The app writes to the portal things that must not be
 * retried (`event.bind`, later — `ai.engine.register`): a request the portal already executed but
 * responded to late would otherwise be resent by the SDK by default (`retryOnNetworkError`, up to 3
 * attempts — b24jssdk 2.2.0 code). Failures from portal rate limits (429, QUERY_LIMIT_EXCEEDED) are
 * still waited out and retried by the SDK: such a request was never executed by the portal. Set once
 * when the frame is created: switching it on every write broke the SDK's rate limiter settings
 * (it remembers them as the initial ones) and was a race.
 */
export function sdkRestrictionParams(): Partial<RestrictionParams> {
  return {
    retryOnNetworkError: false,
    // ERR_BAD_RESPONSE — how axios marks a 5xx response; without it the SDK would treat it as a transient failure.
    hardErrorCodes: ['ERR_BAD_RESPONSE']
  }
}
