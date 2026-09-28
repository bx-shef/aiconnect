// SSRF guard for the portal address. The domain comes from the client (X-B24-Domain header), and
// without an allow-list our server would become a "go wherever I say" primitive — up to and
// including leaking its own token to a foreign host. Ported from client-bank-alfa-by
// (server/utils/b24Rest.ts). The host is extracted via `URL`, not a regex:
// `x.bitrix24.by@evil.com` yields its real host.

/**
 * Cloud Bitrix24 zones. The leading dot is required: it blocks `evil-bitrix24.by`
 * and `x.bitrix24.by.attacker.com`. The list is from the reference app (Bitrix24 DPA zones + 1C-Bitrix zones).
 */
export const B24_CLOUD_HOST_SUFFIXES = [
  '.bitrix24.ru', '.bitrix24.by', '.bitrix24.kz', '.bitrix24.ua',
  '.bitrix24.com', '.bitrix24.eu', '.bitrix24.de', '.bitrix24.fr',
  '.bitrix24.it', '.bitrix24.pl', '.bitrix24.es', '.bitrix24.uk',
  '.bitrix24.com.br', '.bitrix24.com.tr', '.bitrix24.mx', '.bitrix24.co',
  '.bitrix24.cn', '.bitrix24.in', '.bitrix24.id', '.bitrix24.jp',
  '.bitrix24.vn', '.bitrix24.tech'
] as const

/** Bare lowercase host; `''` if it couldn't be parsed. */
export function portalHostname(host: string): string {
  const raw = String(host ?? '').trim().replace(/^https?:\/\//i, '')
  if (!raw) return ''
  try {
    return new URL(`https://${raw}`).hostname.toLowerCase()
  } catch {
    return ''
  }
}

/** Parses the on-premise portal list from the environment (`B24_SELFHOSTED_HOSTS`, comma/space-separated). */
export function parseSelfHostedHosts(raw: string | undefined): Set<string> {
  const out = new Set<string>()
  for (const token of String(raw ?? '').split(/[\s,]+/)) {
    const h = portalHostname(token)
    if (h) out.add(h)
  }
  return out
}

/** Whether the host is allowed: a cloud zone, or an explicitly listed on-premise portal. */
export function isAllowedPortalHost(host: string, selfHosted: Set<string> = new Set()): boolean {
  const h = portalHostname(host)
  if (!h) return false
  if (B24_CLOUD_HOST_SUFFIXES.some(suffix => h.endsWith(suffix))) return true
  return selfHosted.has(h)
}

/** Checks the host and returns the CLEAN name — this is what to put in the URL, not the raw input. */
export function assertPortalHost(host: string, env: Record<string, string | undefined> = process.env): string {
  if (!isAllowedPortalHost(host, parseSelfHostedHosts(env.B24_SELFHOSTED_HOSTS))) {
    throw new Error(`B24 REST refused — host not allow-listed: ${portalHostname(host) || '(unparseable)'}`)
  }
  return portalHostname(host)
}

/**
 * Cloud authorization servers. `oauth.bitrix24.tech` is current per the docs (OAuth articles and
 * the ONAPPINSTALL event example); `oauth.bitrix.info` is the previous address: reference apps
 * used it, and portals from other zones may still live there. Which server a portal uses is
 * given by the install event's `auth[server_endpoint]` ("Authorization server address for token
 * renewal" per the event docs).
 */
export const B24_OAUTH_HOSTS = ['oauth.bitrix24.tech', 'oauth.bitrix.info'] as const
/** Authorization server to use when the event didn't name one (older portal records also lack it). */
export const DEFAULT_OAUTH_HOST = 'oauth.bitrix24.tech'

/**
 * Resolves the install's authorization server from the event's `auth[server_endpoint]`: cloud
 * only, from {@link B24_OAUTH_HOSTS}; no field — {@link DEFAULT_OAUTH_HOST}.
 *
 * Warning: an on-premise portal is never accepted as the authorization server, even one listed in
 * `B24_SELFHOSTED_HOSTS`. An on-premise install vouches for its own domain, but the `member_id`
 * in its "grant" can be anything: its owner could overwrite a victim cloud portal's record, and
 * our `client_secret` would go to them in the renewal request (finding of /code-review). This app
 * is cloud-only; an on-premise install is never stored.
 *
 * @returns the host, or `null` if the server isn't allow-listed (guards against SSRF and grant forgery)
 */
export function resolveOAuthHost(serverEndpoint: string): string | null {
  if (!serverEndpoint.trim()) return DEFAULT_OAUTH_HOST
  const host = portalHostname(serverEndpoint)
  return (B24_OAUTH_HOSTS as readonly string[]).includes(host) ? host : null
}

/**
 * CSP `frame-ancestors` value for pages: only Bitrix24 portals may embed them.
 * Same zone list as the SSRF guard — a single source so the two never drift apart.
 */
export function frameAncestors(selfHostedRaw: string | undefined): string {
  const hosts = [
    ...B24_CLOUD_HOST_SUFFIXES.map(suffix => `https://*${suffix}`),
    ...[...parseSelfHostedHosts(selfHostedRaw)].map(h => `https://${h}`)
  ]
  return `frame-ancestors 'self' ${hosts.join(' ')}`
}
