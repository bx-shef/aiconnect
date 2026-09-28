// Решение по входящему событию портала — чистая функция над внедряемыми зависимостями, чтобы
// ветки установки/удаления проверялись тестом целиком (находка тестировщика панели: обработчик
// не тестировался). Nitro-обработчик `server/api/b24/events.post.ts` только читает тело и
// подставляет живые зависимости. Контракт — docs/B24_EVENTS.md.

import { assertPortalHost, resolveOAuthHost } from './b24Host'
import { appTokenVerdict, B24_EVENT_INSTALL, B24_EVENT_UNINSTALL, eventCode, parseBracketForm, parseEventAuth } from './b24Events'
import { getPortal, removePortal, saveInstall, type KeyValue } from './tokenStore'
import { verifyInstallMember, type OAuthCreds } from './verifyInstallMember'

export interface EventDeps {
  kv: KeyValue
  /** `B24_APPLICATION_TOKEN` из окружения, `''` — не задан. */
  envToken: string
  creds: OAuthCreds
  /** Обновление refresh-токена на сервере авторизации `oauthHost` (verifyInstallMember.rawOauthRefresh). */
  refresh: (refreshToken: string, oauthHost: string) => Promise<unknown>
  /**
   * Лимит адреса отправителя: можно ли обработать событие установки или удаления; `false` — 429.
   * Спрашивается ТОЛЬКО для этих двух событий: прочие не стоят ничего, и раньше они выжигали
   * лимит — чужой портал, подписав наш адрес на поток своих событий, мог заблокировать чужие
   * установки (находка /code-review).
   */
  allowEvent?: () => boolean
  /**
   * Общий потолок сверок установки (`OAUTH_VERIFY_GLOBAL`): спрашивается прямо перед запросом к
   * серверу авторизации, после всех проверок; `false` — 429. Мусор и удаления его не тратят.
   */
  allowVerification?: () => boolean
  /** Окружение для SSRF-гарда (`B24_SELFHOSTED_HOSTS`). */
  env?: Record<string, string | undefined>
  /** Строка в журнал (без токенов). */
  log?: (line: string) => void
  /** Строка в журнал ошибок: то, на что должен сработать мониторинг. */
  warn?: (line: string) => void
}

export interface EventResult {
  status: number
  body: Record<string, unknown>
}

/** Разбирает тело события и решает, что сделать. Не бросает на недоверенном вводе. */
export async function handleB24Event(rawBody: string, deps: EventDeps): Promise<EventResult> {
  const log = deps.log ?? (() => {})
  const warn = deps.warn ?? log
  const payload = parseBracketForm(rawBody)
  const code = eventCode(payload)
  if (code !== B24_EVENT_INSTALL && code !== B24_EVENT_UNINSTALL) {
    return { status: 200, body: { ok: true, ignored: code || 'empty' } }
  }
  if (deps.allowEvent && !deps.allowEvent()) return { status: 429, body: { error: 'too many install events' } }

  let auth
  let domain: string
  try {
    auth = parseEventAuth(payload)
    // Дальше везде — ЧИСТЫЙ хост из гарда, а не сырой ввод: по нему же ищет frameAuth.
    domain = assertPortalHost(auth.domain, deps.env)
  } catch {
    return { status: 400, body: { error: 'malformed event' } }
  }

  if (code === B24_EVENT_UNINSTALL) {
    const stored = await getPortal(deps.kv, auth.memberId)
    const verdict = appTokenVerdict({ isInstall: false, incoming: auth.applicationToken, envToken: deps.envToken, storedToken: stored?.applicationToken })
    if (verdict !== 'accept') return { status: verdict === 'unconfigured' ? 503 : 403, body: { error: `application_token ${verdict}` } }
    // Удалили приложение — не держим о портале ничего.
    await removePortal(deps.kv, auth.memberId)
    log(`uninstall member_id=${auth.memberId}`)
    return { status: 200, body: { ok: true } }
  }

  const verdict = appTokenVerdict({ isInstall: true, incoming: auth.applicationToken, envToken: deps.envToken })
  if (verdict !== 'accept') return { status: 403, body: { error: `application_token ${verdict}` } }

  // ⚠ Fail-closed без реквизитов OAuth. Замер 2026-09-24 (docs/B24_EVENTS.md): без сверки
  // повторная «установка» с тем же member_id и ЧУЖИМИ токенами перезаписывала токены портала.
  if (!deps.creds.clientId || !deps.creds.clientSecret) {
    warn('B24_CLIENT_ID/B24_CLIENT_SECRET not set — install NOT stored')
    return { status: 503, body: { error: 'server not configured' } }
  }
  const oauthHost = resolveOAuthHost(auth.serverEndpoint)
  if (!oauthHost) {
    warn(`install member_id=${auth.memberId} rejected: authorization server not allow-listed`)
    return { status: 403, body: { error: 'authorization server not allowed' } }
  }
  if (deps.allowVerification && !deps.allowVerification()) {
    warn('install verification capacity exhausted — install NOT stored, portal must retry')
    return { status: 429, body: { error: 'too many install verifications' } }
  }
  const bound = await verifyInstallMember(auth.memberId, domain, auth.refreshToken, rt => deps.refresh(rt, oauthHost))
  if (!bound.ok || !bound.grant) {
    warn(`install member_id=${auth.memberId} not verified (${bound.status ?? 503})`)
    return { status: bound.status ?? 503, body: { error: 'install member_id or domain not verified' } }
  }

  const { domain: grantDomain, ...tokens } = bound.grant
  await saveInstall(deps.kv, { memberId: auth.memberId, domain: grantDomain, applicationToken: auth.applicationToken, oauthHost, ...tokens })
  log(`install member_id=${auth.memberId}`)
  return { status: 200, body: { ok: true } }
}
