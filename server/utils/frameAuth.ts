// Проверка фрейм-токена: кто прислал запрос к нашему /api.
//
// Браузер шлёт `Authorization: Bearer <access_token фрейма>` и `X-B24-Domain: <портал>`
// (app/composables/useApi.ts). Сервер НЕ верит ни одному полю на слово:
//   1) домен проходит SSRF-гард и должен принадлежать установке из нашего хранилища —
//      иначе ключ BitrixGPT был бы открыт любому порталу Битрикс24;
//   2) токен проверяется живым вызовом `profile` (кто это и администратор ли он);
//   3) токен обязан принадлежать НАШЕМУ приложению (`app.info.CODE` = `B24_APP_CODE`): фрейм-токен
//      чужого приложения на том же портале тоже прошёл бы `profile`. Без `B24_APP_CODE` сервер
//      отказывает (503), а не пропускает проверку — находка отдела безопасности панели;
//   4) живые проверки ограничены по частоте (`allowLiveCheck`): поток случайных токенов иначе
//      гонял бы наш сервер вызовами `profile` в чужой портал без меры.
// Схема — как в эталонах (resolveFrameMember.ts / settingsHandler.ts), плюс пункты 3–4.

import { createHash } from 'node:crypto'
import { assertPortalHost } from './b24Host'
import { getPortalByDomain, type KeyValue, type PortalRecord } from './tokenStore'

export interface FrameAuth {
  domain: string
  accessToken: string
}

export interface FrameUser {
  userId: number
  isAdmin: boolean
  portal: PortalRecord
}

export type FrameVerdict
  = | { ok: true, user: FrameUser }
    | { ok: false, status: 400 | 401 | 403 | 409 | 429 | 502 | 503, error: string }

/** Заголовки запроса → домен и токен. `null` — чего-то нет или домен не портал Битрикс24. */
export function extractFrameAuth(headers: { get: (name: string) => string | null | undefined }, env?: Record<string, string | undefined>): FrameAuth | null {
  const authz = headers.get('authorization') ?? ''
  const match = /^Bearer\s+(\S+)$/i.exec(authz.trim())
  const rawDomain = headers.get('x-b24-domain') ?? ''
  if (!match || !rawDomain) return null
  try {
    return { domain: assertPortalHost(rawDomain, env), accessToken: match[1]! }
  } catch {
    return null
  }
}

export interface VerifyDeps {
  kv: KeyValue
  /** REST-вызов от имени фрейм-токена (b24Client.makeFrameCall). */
  call: (domain: string, accessToken: string, method: string) => Promise<unknown>
  /** Код нашего приложения (`B24_APP_CODE`); пусто — отказ 503, а не пропуск проверки. */
  appCode: string
  /** Можно ли сейчас сходить в портал с живой проверкой; `false` — 429. По умолчанию — можно. */
  allowLiveCheck?: () => boolean
  now?: () => number
}

/** Кэш проверок: один и тот же токен не гоняем в портал на каждый запрос. Ключ — хэш токена. */
const cache = new Map<string, { until: number, verdict: FrameVerdict }>()
export const VERIFY_CACHE_MS = 60_000
export const VERIFY_CACHE_MAX = 5000

/**
 * Запоминает решение. Кэш полон — сначала снимаются истёкшие, потом самые старые записи до 90 %
 * потолка. Раньше кэш очищался ЦЕЛИКОМ: все сотрудники разом шли на живую проверку и упирались в
 * её лимит по IP — ложные 429 (находка отдела безопасности панели).
 */
function remember(key: string, entry: { until: number, verdict: FrameVerdict }, now: number): void {
  if (cache.size >= VERIFY_CACHE_MAX) {
    for (const [k, v] of cache) {
      if (v.until <= now) cache.delete(k)
    }
    for (const k of cache.keys()) {
      if (cache.size < VERIFY_CACHE_MAX * 0.9) break
      cache.delete(k)
    }
  }
  // Удалить и вставить заново: `set` по существующему ключу оставил бы его на старом месте, и
  // свежеперепроверенный токен вытеснялся бы первым (находка /code-review).
  cache.delete(key)
  cache.set(key, entry)
}

function cacheKey(auth: FrameAuth): string {
  return createHash('sha256').update(`${auth.domain}|${auth.accessToken}`).digest('hex')
}

/** Для тестов: сбросить кэш между сценариями. */
export function resetFrameCache(): void {
  cache.clear()
}

/** Для тестов: сколько решений сейчас в кэше. */
export function frameCacheSize(): number {
  return cache.size
}

/** Похоже ли исключение на отказ в авторизации (а не на сбой сети/портала). */
export function isAuthRejection(message: string): boolean {
  return /expired_token|invalid_token|NO_AUTH_FOUND|INVALID_CREDENTIALS|user_access_error|frame token rejected|\b401\b/i.test(message)
}

export async function verifyFrame(auth: FrameAuth, deps: VerifyDeps): Promise<FrameVerdict> {
  if (!deps.appCode) return { ok: false, status: 503, error: 'server not configured: B24_APP_CODE' }
  const now = deps.now?.() ?? Date.now()
  const key = cacheKey(auth)
  const hit = cache.get(key)
  if (hit && hit.until > now) return hit.verdict

  const portal = await getPortalByDomain(deps.kv, auth.domain)
  if (!portal) return { ok: false, status: 409, error: 'portal not installed' }
  if (deps.allowLiveCheck && !deps.allowLiveCheck()) return { ok: false, status: 429, error: 'too many token checks' }

  let verdict: FrameVerdict
  try {
    const profile = await deps.call(auth.domain, auth.accessToken, 'profile') as { ID?: unknown, ADMIN?: unknown } | null
    const userId = Number(profile?.ID)
    if (!Number.isInteger(userId) || userId <= 0) {
      verdict = { ok: false, status: 401, error: 'profile has no user' }
    } else {
      const info = await deps.call(auth.domain, auth.accessToken, 'app.info') as { CODE?: unknown } | null
      verdict = String(info?.CODE ?? '') === deps.appCode
        ? { ok: true, user: { userId, isAdmin: profile?.ADMIN === true, portal } }
        : { ok: false, status: 403, error: 'token belongs to another application' }
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    return isAuthRejection(message)
      ? { ok: false, status: 401, error: 'frame token rejected' }
      : { ok: false, status: 502, error: 'portal unavailable' }
  }
  remember(key, { until: now + VERIFY_CACHE_MS, verdict }, now)
  return verdict
}
