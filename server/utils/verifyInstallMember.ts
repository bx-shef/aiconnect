// Binding member_id and domain at install time (protection against "install poisoning"). Ported
// from client-bank-alfa-by (server/utils/verifyInstallMember.ts, #162 there) and extended with
// domain verification.
//
// The threat: member_id in ONAPPINSTALL is a field the client sends, while application_token is
// shared across all installs of the app. By installing our app on THEIR OWN portal, an attacker
// can send an "install" with SOMEONE ELSE'S member_id and their own tokens — and that victim
// portal's records would then go through the attacker's token. The defense: we refresh the
// submitted refresh_token against Bitrix24's OAuth server — the response carries the REAL
// member_id of that grant, and it must match the claimed one. Refreshing ROTATES the token: the
// returned grant must be saved, since the submitted one is already spent.
//
// Warning: the domain is verified the same way as member_id. The reference app verified only
// member_id, and /code-review on this PR found a bypass: an attacker sends THEIR OWN member_id
// and their own grant (verification passes), but the victim's `auth[domain]` — and the
// "domain → portal" index starts pointing at the attacker's record. The grant's real domain is
// the host of `client_endpoint` from the OAuth response: the docs ("Automatic OAuth 2.0 token
// renewal") call it "the portal's REST interface address". Warning: the `domain` field of that
// same response is the AUTHORIZATION SERVER's host (`oauth.bitrix24.tech` in the docs' example),
// not the portal's — it must not be used for verification.
//
// The authorization server is whichever one the portal named in `auth[server_endpoint]`, but only
// from the allow-list (`b24Host.ts → resolveOAuthHost`): there's no SSRF here. Secrets go in the
// body, not the URL (the docs show a GET with a query string, but a body is accepted — verified
// against the b24jssdk source, oauth/auth.mjs; the SDK itself sends it the same way).

export const INSTALL_VERIFY_TIMEOUT_MS = 15_000

/** Token renewal URL on the authorization server. */
export function oauthTokenUrl(oauthHost: string): string {
  return `https://${oauthHost}/oauth/token/`
}

/** OAuth codes meaning "the grant is forged" → 403. Everything else — "can't verify" → 503. */
const GRANT_REJECTION_CODES = new Set(['invalid_grant', 'invalid_token', 'expired_token'])

export interface OAuthCreds {
  clientId: string
  clientSecret: string
}

export type OAuthFetchFn = (url: string, init: { method: string, headers: Record<string, string>, body: string, signal?: AbortSignal }) => Promise<{ json: () => Promise<unknown> }>

/**
 * Raw POST to refresh the token. Secrets go in the form body, not the query string (so they
 * don't end up in logs). The host must come from `resolveOAuthHost`; this is only a guard
 * against garbage in the address.
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
  /** Portal host from the grant's `client_endpoint` — the real install domain. */
  domain: string
}

/** Host from `client_endpoint` (`https://x.bitrix24.ru/rest/` → `x.bitrix24.ru`); `''` — unparseable. */
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
  /** 403 — member_id or domain mismatch / forged grant; 503 — can't verify right now. */
  status?: 403 | 503
  grant?: RefreshedGrant
}

/**
 * Verifies the claimed member_id and domain against the real ones from the OAuth grant. Never throws.
 *
 * @param claimedDomain domain from the event, already normalized by the SSRF guard (`assertPortalHost`)
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
  // No member_id or portal address in the response — nothing to verify against: "can't verify", not "accept".
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
