// Входящие события Битрикс24 (ONAPPINSTALL / ONAPPUNINSTALL): разбор тела и проверка
// подлинности. Перенесено из client-bank-alfa-by (app/utils/b24Events.ts), урезано до двух
// событий, которые нам нужны. Контракт — docs/B24_EVENTS.md.

export const B24_EVENT_INSTALL = 'ONAPPINSTALL'
export const B24_EVENT_UNINSTALL = 'ONAPPUNINSTALL'

/** Ключи, через которые тело вебхука могло бы отравить `Object.prototype`. */
const POLLUTING_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

/**
 * Восстанавливает объект из PHP-скобочной формы: `auth[member_id]=abc` → `{ auth: { member_id: 'abc' } }`.
 * Тело недоверенное (адрес вебхука публичный, токен проверяется ПОСЛЕ разбора) — опасные ключи пропускаем.
 */
export function parseBracketForm(raw: string): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of new URLSearchParams(raw)) {
    const path = key.replace(/\]/g, '').split('[')
    if (path.some(seg => POLLUTING_KEYS.has(seg))) continue
    let node: Record<string, unknown> = out
    for (let i = 0; i < path.length; i++) {
      const seg = path[i] as string
      if (i === path.length - 1) {
        node[seg] = value
        break
      }
      if (typeof node[seg] !== 'object' || node[seg] === null) node[seg] = {}
      node = node[seg] as Record<string, unknown>
    }
  }
  return out
}

/** Код события в верхнем регистре; `''`, если его нет. */
export function eventCode(payload: unknown): string {
  const code = (payload as { event?: unknown } | null)?.event
  return typeof code === 'string' ? code.toUpperCase() : ''
}

/** Сравнение за постоянное время — не выдаёт по таймингу, сколько символов секрета совпало. */
export function safeEqual(a: string, b: string): boolean {
  const len = Math.max(a.length, b.length)
  let diff = a.length ^ b.length
  for (let i = 0; i < len; i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0)
  return diff === 0
}

export type AppTokenVerdict = 'accept' | 'forbidden' | 'unconfigured'

/**
 * Проверка `application_token` (fail-closed).
 * • Установка: если токен задан в окружении — сверяем с ним; иначе первый непустой принимается.
 * • Остальные события: нужен ожидаемый токен (окружение или сохранённый при установке);
 *   нет ни того, ни другого — `unconfigured` (503), а не «поверим на слово».
 */
export function appTokenVerdict(opts: { isInstall: boolean, incoming: string, envToken?: string, storedToken?: string }): AppTokenVerdict {
  const envToken = opts.envToken ?? ''
  if (opts.isInstall) {
    if (envToken) return safeEqual(opts.incoming, envToken) ? 'accept' : 'forbidden'
    return opts.incoming ? 'accept' : 'forbidden'
  }
  const expected = envToken || opts.storedToken || ''
  if (!expected) return 'unconfigured'
  return safeEqual(opts.incoming, expected) ? 'accept' : 'forbidden'
}

export interface EventAuth {
  domain: string
  memberId: string
  applicationToken: string
  accessToken: string
  refreshToken: string
  expiresIn: number
  /** `auth[server_endpoint]` — сервер авторизации портала; `''`, если поля нет. */
  serverEndpoint: string
}

/** Блок `auth` события. Бросает, если нет домена, member_id или application_token. */
export function parseEventAuth(payload: unknown): EventAuth {
  const a = (payload as { auth?: unknown } | null)?.auth as Record<string, unknown> | undefined
  if (!a || typeof a !== 'object') throw new Error('B24 event: missing auth block')
  const str = (v: unknown) => (typeof v === 'string' ? v : '')
  const domain = str(a.domain)
  const memberId = str(a.member_id)
  const applicationToken = str(a.application_token)
  if (!domain || !memberId || !applicationToken) throw new Error('B24 event: auth is missing domain/member_id/application_token')
  const expiresIn = Number(a.expires_in)
  return {
    domain,
    memberId,
    applicationToken,
    accessToken: str(a.access_token),
    refreshToken: str(a.refresh_token),
    expiresIn: Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : 3600,
    serverEndpoint: str(a.server_endpoint)
  }
}
