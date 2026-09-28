// Общая обвязка API-обработчиков: кто пришёл и какими клиентами Битрикс24 ему служить.
// Использует автоимпорты Nitro (useStorage, createError, getRequestHeaders), поэтому живёт
// отдельно от чистых модулей, которые покрыты юнит-тестами.

import type { H3Event } from 'h3'
import { AiGatewayError } from './aiGateway'
import { makeFrameCall, makePortalCall, oauthCredsFromEnv, type RestCall } from './b24Client'
import { extractFrameAuth, verifyFrame, type FrameUser } from './frameAuth'
import { makeInstallerCall } from './installerCall'
import { SlidingWindow } from './rateLimit'
import { FRAME_CHECKS_PER_IP, ipBucketKey, pickClientIp } from './requestLimits'
import { accessTokenOf, refreshTokenOf, updateTokens, type KeyValue } from './tokenStore'

const frameCheckWindows = new SlidingWindow()

/** IP клиента для лимитов: `X-Forwarded-For` — только при `TRUST_PROXY=1` (см. `pickClientIp`). */
export function clientIp(event: H3Event): string {
  return pickClientIp(getRequestHeader(event, 'x-forwarded-for'), getRequestIP(event), process.env.TRUST_PROXY === '1')
}

/** Хранилище установок (fs-драйвер, см. `nitro.storage` в nuxt.config.ts). */
export function portalStore(): KeyValue {
  return useStorage('portals') as unknown as KeyValue
}

export interface RequestContext {
  user: FrameUser
  /** REST от имени пользователя фрейма — его права. */
  frameCall: RestCall
}

/** Проверяет фрейм-токен запроса. Бросает h3-ошибку с кодом, если пустить нельзя. */
export async function requireFrameUser(event: H3Event): Promise<RequestContext> {
  const headers = getRequestHeaders(event)
  const auth = extractFrameAuth({ get: name => headers[name] })
  if (!auth) throw createError({ statusCode: 400, statusMessage: 'frame auth headers required' })
  const creds = oauthCredsFromEnv()
  const ip = clientIp(event)
  const verdict = await verifyFrame(auth, {
    kv: portalStore(),
    call: (domain, token, method) => makeFrameCall(domain, token, creds)(method),
    appCode: process.env.B24_APP_CODE?.trim() || '',
    // Живая проверка — вызов в портал; поток случайных токенов не должен гонять нас туда без меры.
    allowLiveCheck: () => frameCheckWindows.take([[`fv:${ipBucketKey(ip)}`, FRAME_CHECKS_PER_IP]])
  })
  if (!verdict.ok) throw createError({ statusCode: verdict.status, statusMessage: verdict.error })
  return { user: verdict.user, frameCall: makeFrameCall(auth.domain, auth.accessToken, creds) }
}

/**
 * REST от имени администратора-установщика (сохранённый токен). Нужен только там, где права
 * пользователя недостаточны по документации, — сейчас это запись ставок не-администратором.
 * Запись о портале читается заново на каждый вызов (`installerCall.ts`): в `FrameUser.portal` — копия
 * из минутного кэша проверки фрейма, после рефреша в ней старые токены.
 */
export function installerCall(user: FrameUser): RestCall {
  const kv = portalStore()
  const creds = oauthCredsFromEnv()
  return makeInstallerCall({
    kv,
    memberId: user.portal.memberId,
    clientFor: p => makePortalCall(
      {
        domain: p.domain,
        memberId: p.memberId,
        accessToken: accessTokenOf(p),
        refreshToken: refreshTokenOf(p),
        expiresAt: p.expiresAt,
        applicationToken: p.applicationToken,
        oauthHost: p.oauthHost
      },
      creds,
      tokens => updateTokens(kv, p.memberId, tokens)
    )
  })
}

/** Переводит отказ AI-шлюза в HTTP-ошибку h3; прочие ошибки пробрасывает как есть. */
export function aiHttpError(e: unknown): unknown {
  return e instanceof AiGatewayError ? createError({ statusCode: e.statusCode, statusMessage: e.message }) : e
}
