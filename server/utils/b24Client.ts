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

/** Своё локальное приложение шпиона: хост и его реквизиты (`B24_SPY_APPS` или `B24_SPY_BOX_APP`). */
export type SpyApp = SpyBoxApp

/** Состояние `B24_SPY_BOX_APP`: не задана, действует или задана с ошибкой (что не так — без значений). */
export type SpyBoxState = { state: 'off' } | { state: 'on', app: SpyBoxApp } | { state: 'invalid', host: string, reason: string }

type Env = Record<string, string | undefined>

/** Строка `<хост> <client_id> <client_secret> <код>`: приложение или причина отказа (без значений). */
type AppLine = { app: SpyApp } | { host: string, reason: string }

/**
 * Общий разбор строки приложения шпиона для `B24_SPY_BOX_APP` и `B24_SPY_APPS`. В отчёт хост
 * попадает, только если похож на домен (есть точка): сдвинутое поле с секретом в журнал не уйдёт.
 */
function parseAppLine(line: string): AppLine | null {
  const parts = line.trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return null
  const parsed = portalHostname(parts[0] ?? '')
  const host = parsed.includes('.') ? parsed : ''
  if (parts.length !== 4) return { host, reason: `expected 4 fields, got ${parts.length}` }
  if (!host) return { host, reason: 'host is not a hostname' }
  const [, clientId, clientSecret, appCode] = parts as [string, string, string, string]
  return { app: { host, creds: { clientId, clientSecret }, appCode } }
}

/**
 * Отдельное локальное приложение на коробке-стенде шпиона (`B24_SPY_BOX_APP`:
 * `<хост> <client_id> <client_secret> <код приложения>` через пробел, в значениях пробелов нет).
 * У локального приложения коробки свои реквизиты и код, у облачного — свои, а сервер один.
 * Действует, только если хост есть и в `B24_SELFHOSTED_HOSTS`, и в `B24_SPY_PORTALS`: это наш
 * стенд, клиентским коробкам приложение не ставится. Хост приводится как в списках
 * (`portalHostname`: без схемы, порта, в нижнем регистре).
 */
export function spyBoxState(env: Env = process.env): SpyBoxState {
  const line = parseAppLine(env.B24_SPY_BOX_APP ?? '')
  if (!line) return { state: 'off' }
  if (!('app' in line)) return { state: 'invalid', host: line.host, reason: line.reason }
  const host = line.app.host
  if (!parseSelfHostedHosts(env.B24_SELFHOSTED_HOSTS).has(host)) return { state: 'invalid', host, reason: 'host not in B24_SELFHOSTED_HOSTS' }
  if (!parseSelfHostedHosts(env.B24_SPY_PORTALS).has(host)) return { state: 'invalid', host, reason: 'host not in B24_SPY_PORTALS' }
  return { state: 'on', app: line.app }
}

/** Коробка-стенд, если `B24_SPY_BOX_APP` задана верно; иначе `null`. */
export function spyBoxApp(env: Env = process.env): SpyBoxApp | null {
  const s = spyBoxState(env)
  return s.state === 'on' ? s.app : null
}

/** Хост коробки-стенда (и заданной с ошибкой); не задана или хоста нет — `''`. */
function spyBoxHost(box: SpyBoxState): string {
  return box.state === 'on' ? box.app.host : box.state === 'invalid' ? box.host : ''
}

/**
 * Состояние `B24_SPY_APPS` (хост и причина — без значений):
 * * `apps` — действующие приложения;
 * * `invalid` — хосты наших тестовых порталов (из `B24_SPY_PORTALS`) с кривой строкой или дублем:
 *   для них реквизиты пустые (503), облачный секрет на чужой грант не уходит;
 * * `ignored` — строки, которые ни на что не влияют: хост не из `B24_SPY_PORTALS` (портал работает
 *   с облачными реквизитами, как без строки), хост коробки-стенда (действует `B24_SPY_BOX_APP`),
 *   строка без хоста.
 */
export interface SpyAppsState {
  apps: SpyApp[]
  invalid: Array<{ host: string, reason: string }>
  ignored: Array<{ host: string, reason: string }>
}

let cache: { key: string, state: SpyAppsState } | null = null

/**
 * Свои локальные приложения шпиона на облачных порталах (`B24_SPY_APPS`): по строке на портал,
 * строки через `;`, в строке `<хост> <client_id> <client_secret> <код приложения>` через пробел.
 * У каждого локального приложения облака свои реквизиты (у `.by` и `.ru` разные), а сервер один.
 * Действует, только если хост есть в `B24_SPY_PORTALS`; хост коробки-стенда — за `B24_SPY_BOX_APP`.
 * Хост дважды — не действует ни одна его строка (какая верна, не угадываем). Разбор кешируется
 * по значениям переменных: окружение после старта не меняется, а спрашивают на каждый запрос.
 */
export function spyAppsState(env: Env = process.env): SpyAppsState {
  const key = JSON.stringify([env.B24_SPY_APPS ?? '', env.B24_SPY_PORTALS ?? '', env.B24_SPY_BOX_APP ?? '', env.B24_SELFHOSTED_HOSTS ?? ''])
  if (cache?.key === key) return cache.state
  const spy = parseSelfHostedHosts(env.B24_SPY_PORTALS)
  const boxHost = spyBoxHost(spyBoxState(env))
  const apps: SpyApp[] = []
  const invalid: SpyAppsState['invalid'] = []
  const ignored: SpyAppsState['ignored'] = []
  const seen = new Set<string>()
  const dup = new Set<string>()
  for (const raw of (env.B24_SPY_APPS ?? '').split(';')) {
    const line = parseAppLine(raw)
    if (!line) continue
    const host = 'app' in line ? line.app.host : line.host
    if (!host) ignored.push({ host, reason: 'app' in line ? 'host is not a hostname' : line.reason })
    else if (!spy.has(host)) ignored.push({ host, reason: 'host not in B24_SPY_PORTALS' })
    else if (host === boxHost) ignored.push({ host, reason: 'host is the spy box (B24_SPY_BOX_APP)' })
    else {
      // Хост дважды — по всем строкам наших порталов, и по кривым тоже
      (seen.has(host) ? dup : seen).add(host)
      if ('app' in line) apps.push(line.app)
      else invalid.push({ host, reason: line.reason })
    }
  }
  for (const host of dup) {
    for (let i = invalid.length - 1; i >= 0; i--) if (invalid[i]?.host === host) invalid.splice(i, 1)
    invalid.push({ host, reason: 'host listed twice' })
  }
  const state = { apps: apps.filter(a => !dup.has(a.host)), invalid, ignored }
  cache = { key, state }
  return state
}

/**
 * У портала своё локальное приложение шпиона (`B24_SPY_APPS` или `B24_SPY_BOX_APP`, в том числе
 * заданное с ошибкой): общий `B24_APPLICATION_TOKEN` к нему не относится — токен у каждого
 * приложения свой, его задаёт первая установка (как у приложения из Маркета). Строки из
 * `ignored` (хост не из `B24_SPY_PORTALS`) портал не трогают: для него общий токен действует.
 */
export function ownSpyApp(domain: string, env: Env = process.env): boolean {
  const host = portalHostname(domain)
  if (!host) return false
  const apps = spyAppsState(env)
  if (apps.apps.some(a => a.host === host) || apps.invalid.some(i => i.host === host)) return true
  return spyBoxHost(spyBoxState(env)) === host
}

/** `B24_APPLICATION_TOKEN` для домена события: у своих приложений шпиона общий токен не действует. */
export function envTokenFor(domain: string, env: Env = process.env): string {
  return ownSpyApp(domain, env) ? '' : env.B24_APPLICATION_TOKEN?.trim() || ''
}

/** Счётчики для `/api/health`: без хостов и значений. */
export function spyAppsHealth(env: Env = process.env): { on: number, invalid: number, ignored: number } {
  const s = spyAppsState(env)
  return { on: s.apps.length, invalid: s.invalid.length, ignored: s.ignored.length }
}

/**
 * Приложение для портала: своё приложение шпиона из `B24_SPY_APPS` или коробка-стенд шпиона — их
 * реквизиты, иначе — облачные из окружения.
 * ⚠ `B24_SPY_APPS` (кривая строка или дубль для нашего портала) или `B24_SPY_BOX_APP` заданы с
 * ошибкой — для их хоста пустые реквизиты (установка 503, фрейм 503), а не облачные: иначе облачный
 * секрет ушёл бы на сверку чужого гранта (находка панели).
 */
export function appForPortal(domain: string, env: Env = process.env): PortalApp {
  const host = portalHostname(domain)
  const empty = { creds: { clientId: '', clientSecret: '' }, appCode: '' }
  const spyApps = spyAppsState(env)
  const own = spyApps.apps.find(a => a.host === host)
  if (own) return { creds: own.creds, appCode: own.appCode }
  if (host && spyApps.invalid.some(i => i.host === host)) return empty
  const box = spyBoxState(env)
  if (box.state === 'on' && box.app.host === host) return { creds: box.app.creds, appCode: box.app.appCode }
  if (box.state === 'invalid' && box.host && box.host === host) return empty
  return { creds: oauthCredsFromEnv(env), appCode: env.B24_APP_CODE?.trim() || '' }
}
