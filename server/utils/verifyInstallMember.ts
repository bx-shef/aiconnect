// Привязка member_id и домена при установке (защита от «отравления установки»). Перенесено из
// client-bank-alfa-by (server/utils/verifyInstallMember.ts, #162 там) и дополнено сверкой домена.
//
// Суть угрозы: member_id в ONAPPINSTALL — поле, которое присылает клиент, а application_token
// общий для всех установок приложения. Установив наше приложение на СВОЙ портал, злоумышленник
// может прислать «установку» с ЧУЖИМ member_id и своими токенами — и записи ставок чужого
// портала пошли бы через его токен. Защита: обновляем присланный refresh_token на OAuth-сервере
// Битрикс24 — ответ несёт НАСТОЯЩИЙ member_id этого гранта, и он обязан совпасть с заявленным.
// Обновление РОТИРУЕТ токен: сохранять нужно вернувшийся грант, присланный уже истрачен.
//
// ⚠ Домен сверяется так же, как member_id. Эталон сверял только member_id, и /code-review
// этого PR нашёл обход: злоумышленник присылает СВОЙ member_id и свой грант (сверка проходит), но
// `auth[domain]` жертвы — и индекс «домен → портал» начинает указывать на его запись. Настоящий
// домен гранта — хост `client_endpoint` из ответа OAuth: документация («Автоматическое продление
// токенов OAuth 2.0») называет его «адрес REST-интерфейса портала». ⚠ Поле `domain` того же
// ответа — хост СЕРВЕРА АВТОРИЗАЦИИ (`oauth.bitrix24.tech` в примере документации), не портала:
// сверять по нему нельзя.
//
// Сервер авторизации — тот, что назвал портал в `auth[server_endpoint]`, но только из белого
// списка (`b24Host.ts → resolveOAuthHost`): SSRF здесь нет. Секреты идут в теле, не в URL
// (документация показывает GET со строкой запроса, тело принимается — проверено авторами
// b24jssdk, oauth/auth.mjs; так же шлёт и сам SDK).

export const INSTALL_VERIFY_TIMEOUT_MS = 15_000

/** Адрес продления токена на сервере авторизации. */
export function oauthTokenUrl(oauthHost: string): string {
  return `https://${oauthHost}/oauth/token/`
}

/** Коды OAuth, означающие «грант поддельный» → 403. Остальное — «не можем проверить» → 503. */
const GRANT_REJECTION_CODES = new Set(['invalid_grant', 'invalid_token', 'expired_token'])

export interface OAuthCreds {
  clientId: string
  clientSecret: string
}

export type OAuthFetchFn = (url: string, init: { method: string, headers: Record<string, string>, body: string, signal?: AbortSignal }) => Promise<{ json: () => Promise<unknown> }>

/**
 * Сырой POST обновления токена. Секреты — в теле формы, не в строке запроса (не попадут в логи).
 * Хост обязан прийти из `resolveOAuthHost`; здесь — только защита от мусора в адресе.
 */
export function rawOauthRefresh(fetchFn: OAuthFetchFn, creds: OAuthCreds, timeoutMs = INSTALL_VERIFY_TIMEOUT_MS) {
  return async (refreshToken: string, oauthHost: string): Promise<unknown> => {
    if (!/^[a-z0-9.-]+$/.test(oauthHost)) throw new Error('oauth host is not a plain hostname')
    const res = await fetchFn(oauthTokenUrl(oauthHost), {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: creds.clientId,
        client_secret: creds.clientSecret,
        refresh_token: refreshToken
      }).toString(),
      signal: AbortSignal.timeout(timeoutMs)
    })
    return res.json()
  }
}

export interface RefreshedGrant {
  accessToken: string
  refreshToken: string
  expiresIn: number
  /** Хост портала из `client_endpoint` гранта — настоящий домен установки. */
  domain: string
}

/** Хост из `client_endpoint` (`https://x.bitrix24.ru/rest/` → `x.bitrix24.ru`); `''` — не разобрать. */
export function endpointHost(endpoint: unknown): string {
  if (typeof endpoint !== 'string' || !endpoint) return ''
  try {
    return new URL(endpoint).hostname.toLowerCase()
  } catch {
    return ''
  }
}

export interface InstallMemberResult {
  ok: boolean
  /** 403 — member_id или домен не совпали / грант поддельный; 503 — проверить сейчас нельзя. */
  status?: 403 | 503
  grant?: RefreshedGrant
}

/**
 * Сверяет заявленные member_id и домен с настоящими из OAuth-гранта. Никогда не бросает.
 *
 * @param claimedDomain домен из события, уже нормализованный SSRF-гардом (`assertPortalHost`)
 */
export async function verifyInstallMember(claimedMemberId: string, claimedDomain: string, refreshToken: string, refresh: (rt: string) => Promise<unknown>): Promise<InstallMemberResult> {
  const claimed = claimedMemberId.trim().toLowerCase()
  const claimedHost = claimedDomain.trim().toLowerCase()
  if (!claimed || !claimedHost || !refreshToken) return { ok: false, status: 403 }
  let raw: unknown
  try {
    raw = await refresh(refreshToken)
  } catch {
    return { ok: false, status: 503 }
  }
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const accessToken = typeof o.access_token === 'string' ? o.access_token : ''
  if (!accessToken) {
    return { ok: false, status: GRANT_REJECTION_CODES.has(String(o.error)) ? 403 : 503 }
  }
  const authoritative = String(o.member_id ?? '').trim().toLowerCase()
  const authoritativeHost = endpointHost(o.client_endpoint)
  // Нет member_id или адреса портала в ответе — сверять нечем: «не можем проверить», а не «принять».
  if (!authoritative || !authoritativeHost) return { ok: false, status: 503 }
  if (authoritative !== claimed || authoritativeHost !== claimedHost) return { ok: false, status: 403 }
  const expiresIn = Number(o.expires_in)
  return {
    ok: true,
    grant: {
      accessToken,
      refreshToken: typeof o.refresh_token === 'string' ? o.refresh_token : '',
      expiresIn: Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : 3600,
      domain: authoritativeHost
    }
  }
}
