// Вызовы REST Битрикс24 с сервера — через @bitrix24/b24jssdk (класс B24OAuth), как в эталоне
// client-bank-alfa-by (server/utils/b24Sdk.ts). Два вида клиента:
//   • по фрейм-токену пользователя — права этого пользователя, обновить токен нельзя;
//   • по сохранённому токену установки — права администратора-установщика, с рефрешем.
// Все исходящие методы перечислены в docs/REST_METHODS.md.

import { B24OAuth } from '@bitrix24/b24jssdk'
import type { B24OAuthParams } from '@bitrix24/b24jssdk'
import { assertPortalHost, DEFAULT_OAUTH_HOST, parseSelfHostedHosts, portalHostname } from './b24Host'
import type { OAuthCreds } from './verifyInstallMember'

/** Вызов REST-метода: результат (`result` конверта) или исключение с текстом ошибок портала. */
export type RestCall = (method: string, params?: Record<string, unknown>) => Promise<unknown>

/** Сообщение, по которому видно, что фрейм-токен отвергнут (обновить его на сервере нельзя). */
export const FRAME_TOKEN_REJECTED = 'frame token rejected'

interface TokenInput {
  domain: string
  memberId: string
  accessToken: string
  refreshToken: string
  expiresAt: number
  applicationToken: string
  /** Сервер авторизации портала (запись о портале); не задан — по умолчанию. */
  oauthHost?: string
}

/**
 * Параметры B24OAuth из нашей записи о токене. Хост портала проходит SSRF-гард. Сервер
 * авторизации — свой у портала (`auth[server_endpoint]` установки): SDK шлёт рефреш на
 * `<serverEndpoint без /rest/>/oauth/token/`.
 */
export function oauthParams(token: TokenInput, nowMs: number): B24OAuthParams {
  const domain = assertPortalHost(token.domain)
  return {
    applicationToken: token.applicationToken,
    userId: 0,
    memberId: token.memberId,
    accessToken: token.accessToken,
    refreshToken: token.refreshToken,
    expires: Math.floor(token.expiresAt / 1000),
    expiresIn: Math.max(0, Math.floor((token.expiresAt - nowMs) / 1000)),
    scope: '',
    domain,
    clientEndpoint: `https://${domain}/rest/`,
    serverEndpoint: `https://${token.oauthHost || DEFAULT_OAUTH_HOST}/rest/`,
    status: 'L'
  }
}

/** Структурный срез клиента SDK, который мы зовём, — тесты подсовывают подделку. */
export interface SdkCallClient {
  actions: {
    v2: {
      call: {
        make: (o: { method: string, params?: Record<string, unknown> }) => Promise<{
          isSuccess: boolean
          getData: () => { result?: unknown } | undefined
          getErrorMessages: () => string[]
        }>
      }
    }
  }
}

/** Обёртка клиента в `RestCall`: разворачивает конверт или бросает с сообщениями портала. */
export function restCallFrom(client: SdkCallClient): RestCall {
  return async (method, params = {}) => {
    const res = await client.actions.v2.call.make({ method, params })
    if (!res.isSuccess) throw new Error(`${method}: ${res.getErrorMessages().join('; ') || 'unknown error'}`)
    return res.getData()?.result
  }
}

/**
 * Клиент по фрейм-токену. Своего refresh-токена у сервера нет: любая ошибка авторизации —
 * окончательный отказ, а не «обнови меня» (иначе SDK POST-ил бы пустой refresh_token).
 */
export function makeFrameCall(domain: string, accessToken: string, creds: OAuthCreds, nowMs = Date.now()): RestCall {
  const client = new B24OAuth(oauthParams({
    domain, memberId: '', accessToken, refreshToken: '', expiresAt: nowMs + 3_600_000, applicationToken: ''
  }, nowMs), creds)
  client.setCustomRefreshAuth(() => Promise.reject(new Error(FRAME_TOKEN_REJECTED)))
  return restCallFrom(client)
}

/**
 * Клиент по сохранённому токену установки. SDK сам обновит просроченный access-токен и
 * отдаст новые токены в `persist` — их надо сохранить, иначе следующий вызов начнёт со старого.
 */
export function makePortalCall(
  token: TokenInput,
  creds: OAuthCreds,
  persist: (t: { accessToken: string, refreshToken: string, expiresAt: number }) => Promise<void>,
  nowMs = Date.now()
): RestCall {
  const client = new B24OAuth(oauthParams(token, nowMs), creds)
  client.setCallbackRefreshAuth(async ({ b24OAuthParams }) => {
    await persist({
      accessToken: b24OAuthParams.accessToken,
      refreshToken: b24OAuthParams.refreshToken,
      expiresAt: b24OAuthParams.expires * 1000
    })
  })
  return restCallFrom(client)
}

/** OAuth-реквизиты приложения из окружения; пустые строки — не заданы. */
export function oauthCredsFromEnv(env: Record<string, string | undefined> = process.env): OAuthCreds {
  return {
    clientId: env.B24_CLIENT_ID?.trim() || '',
    clientSecret: env.B24_CLIENT_SECRET?.trim() || ''
  }
}

/** Реквизиты и код приложения для одного портала. */
export interface PortalApp { creds: OAuthCreds, appCode: string }

/** Коробка-стенд шпиона из `B24_SPY_BOX_APP`. */
export interface SpyBoxApp extends PortalApp { host: string }

/** Состояние `B24_SPY_BOX_APP`: не задана, действует или задана с ошибкой (что не так — без значений). */
export type SpyBoxState = { state: 'off' } | { state: 'on', app: SpyBoxApp } | { state: 'invalid', host: string, reason: string }

/**
 * Отдельное локальное приложение на коробке-стенде шпиона (`B24_SPY_BOX_APP`:
 * `<хост> <client_id> <client_secret> <код приложения>` через пробел, в значениях пробелов нет).
 * У локального приложения коробки свои реквизиты и код, у облачного — свои, а сервер один.
 * Действует, только если хост есть и в `B24_SELFHOSTED_HOSTS`, и в `B24_SPY_PORTALS`: это наш
 * стенд, клиентским коробкам приложение не ставится. Хост приводится как в списках
 * (`portalHostname`: без схемы, порта, в нижнем регистре).
 */
export function spyBoxState(env: Record<string, string | undefined> = process.env): SpyBoxState {
  const raw = (env.B24_SPY_BOX_APP ?? '').trim()
  if (!raw) return { state: 'off' }
  const parts = raw.split(/\s+/)
  const host = portalHostname(parts[0] ?? '')
  if (parts.length !== 4) return { state: 'invalid', host, reason: `expected 4 fields, got ${parts.length}` }
  if (!host) return { state: 'invalid', host, reason: 'host is not a hostname' }
  if (!parseSelfHostedHosts(env.B24_SELFHOSTED_HOSTS).has(host)) return { state: 'invalid', host, reason: 'host not in B24_SELFHOSTED_HOSTS' }
  if (!parseSelfHostedHosts(env.B24_SPY_PORTALS).has(host)) return { state: 'invalid', host, reason: 'host not in B24_SPY_PORTALS' }
  const [, clientId, clientSecret, appCode] = parts as [string, string, string, string]
  return { state: 'on', app: { host, creds: { clientId, clientSecret }, appCode } }
}

/** Коробка-стенд, если `B24_SPY_BOX_APP` задана верно; иначе `null`. */
export function spyBoxApp(env: Record<string, string | undefined> = process.env): SpyBoxApp | null {
  const s = spyBoxState(env)
  return s.state === 'on' ? s.app : null
}

/** Состояние `B24_SPY_APPS`: действующие приложения и строки с ошибкой (хост и причина — без значений). */
export interface SpyAppsState { apps: SpyBoxApp[], invalid: Array<{ host: string, reason: string }> }

/**
 * Свои локальные приложения шпиона на облачных порталах (`B24_SPY_APPS`): по строке на портал,
 * строки через `;`, в строке `<хост> <client_id> <client_secret> <код приложения>` через пробел.
 * У каждого локального приложения облака свои реквизиты (у `.by` и `.ru` разные), а сервер один.
 * Действует, только если хост есть в `B24_SPY_PORTALS`: это наши тестовые порталы. Один хост
 * дважды — не действует ни одна его строка (какая верна, не угадываем).
 */
export function spyAppsState(env: Record<string, string | undefined> = process.env): SpyAppsState {
  const spy = parseSelfHostedHosts(env.B24_SPY_PORTALS)
  const apps: SpyBoxApp[] = []
  const invalid: SpyAppsState['invalid'] = []
  for (const line of (env.B24_SPY_APPS ?? '').split(';')) {
    const parts = line.trim().split(/\s+/).filter(Boolean)
    if (parts.length === 0) continue
    const host = portalHostname(parts[0] ?? '')
    if (parts.length !== 4) invalid.push({ host, reason: `expected 4 fields, got ${parts.length}` })
    else if (!host) invalid.push({ host, reason: 'host is not a hostname' })
    else if (!spy.has(host)) invalid.push({ host, reason: 'host not in B24_SPY_PORTALS' })
    else {
      const [, clientId, clientSecret, appCode] = parts as [string, string, string, string]
      apps.push({ host, creds: { clientId, clientSecret }, appCode })
    }
  }
  const seen = new Set<string>()
  const dup = new Set<string>()
  for (const h of apps.map(a => a.host)) (seen.has(h) ? dup : seen).add(h)
  for (const h of dup) invalid.push({ host: h, reason: 'host listed twice' })
  return { apps: apps.filter(a => !dup.has(a.host)), invalid }
}

/**
 * Приложение для портала: своё приложение шпиона из `B24_SPY_APPS` или коробка-стенд шпиона — их
 * реквизиты, иначе — облачные из окружения.
 * ⚠ `B24_SPY_BOX_APP` задана с ошибкой — для её хоста пустые реквизиты (установка 503, фрейм
 * 503), а не облачные: иначе облачный секрет ушёл бы на сверку чужого гранта (находка панели).
 */
export function appForPortal(domain: string, env: Record<string, string | undefined> = process.env): PortalApp {
  const host = portalHostname(domain)
  // B24_SPY_APPS — раньше коробки и облака; строка с ошибкой для хоста — пустые реквизиты, как у коробки:
  // облачный секрет не уходит на сверку чужого гранта
  const spyApps = spyAppsState(env)
  const own = spyApps.apps.find(a => a.host === host)
  if (own) return { creds: own.creds, appCode: own.appCode }
  if (host && spyApps.invalid.some(i => i.host === host)) return { creds: { clientId: '', clientSecret: '' }, appCode: '' }
  const box = spyBoxState(env)
  if (box.state === 'on' && box.app.host === host) return { creds: box.app.creds, appCode: box.app.appCode }
  if (box.state === 'invalid' && box.host && box.host === host) return { creds: { clientId: '', clientSecret: '' }, appCode: '' }
  return { creds: oauthCredsFromEnv(env), appCode: env.B24_APP_CODE?.trim() || '' }
}
