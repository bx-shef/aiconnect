// Incoming /api request limits — protects the one server we all share from memory exhaustion and
// from a flood of requests against the public webhook address (finding from the panel's security
// team: an anonymous 15 MB POST was accepted whole). Pure functions; applied by
// server/middleware/requestLimits.ts.

import type { WindowLimit } from './rateLimit'

/** Portal event body — a PHP-form a few hundred bytes long; 64 KB gives plenty of headroom. */
export const EVENTS_BODY_LIMIT = 64 * 1024
/**
 * Other POSTs. There are no POST handlers besides events at stage 0; the limit leaves headroom
 * for BitrixGPT requests to `completions_url` (stage 1 of docs/PLAN.md will measure their size).
 */
export const API_BODY_LIMIT = 512 * 1024

/**
 * Rate of install/uninstall events from one address (other events don't count —
 * b24EventsHandler.ts). Bitrix24 sends these from its own servers, and floods of installs don't
 * happen there.
 */
export const EVENTS_PER_IP: WindowLimit = { max: 60, windowMs: 60_000 }
/**
 * Global cap on install verifications: each one is an outgoing request to the authorization
 * server with our client_id/secret, and a flood of forged installs from thousands of addresses
 * must not turn into a flood of such requests (Bitrix24 may block our keys for abuse). Charged
 * right before the request, after all other checks: garbage and uninstall events don't spend it —
 * otherwise a flood of garbage would block real uninstalls (finding of /code-review).
 */
export const OAUTH_VERIFY_GLOBAL: WindowLimit = { max: 600, windowMs: 60_000 }
/** Live frame-token checks (`profile` calls into someone else's portal) from a single IP. */
export const FRAME_CHECKS_PER_IP: WindowLimit = { max: 60, windowMs: 60_000 }

/** Body limit for a path; `null` — the path is unlimited (pages, GET). */
export function bodyLimitFor(method: string, path: string): number | null {
  if (method.toUpperCase() !== 'POST' || !path.startsWith('/api/')) return null
  return path.startsWith('/api/b24/events') ? EVENTS_BODY_LIMIT : API_BODY_LIMIT
}

export type BodyVerdict = { ok: true } | { ok: false, status: 411 | 413 }

/**
 * Verdict based on the `Content-Length` header. Missing — 411: both the portal and our own page
 * send it, and a body of unknown length would have to be read in full just to learn it's too big.
 */
export function checkBodySize(contentLength: string | undefined | null, limit: number): BodyVerdict {
  if (contentLength === undefined || contentLength === null || contentLength.trim() === '') return { ok: false, status: 411 }
  const n = Number(contentLength)
  if (!Number.isInteger(n) || n < 0) return { ok: false, status: 411 }
  return n > limit ? { ok: false, status: 413 } : { ok: true }
}

/** IPv4-mapped IPv6 → IPv4: `::ffff:10.0.0.1` and `::ffff:a00:1` → `10.0.0.1`; everything else is left as-is. */
function unmapIPv4(ip: string): string {
  const a = ip.trim().toLowerCase()
  if (!a.startsWith('::ffff:')) return a
  const tail = a.slice('::ffff:'.length)
  const hex = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(tail)
  if (!hex) return tail
  const hi = Number.parseInt(hex[1]!, 16)
  const lo = Number.parseInt(hex[2]!, 16)
  return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`
}

/**
 * Address key for rate limits: IPv4 — the full address, IPv6 — the /64 network. A single client
 * is usually assigned a whole /64, and a limit keyed on the full address could be bypassed by
 * cycling through addresses within it (finding of /code-review).
 */
export function ipBucketKey(ip: string): string {
  const a = unmapIPv4(String(ip ?? ''))
  if (!a.includes(':')) return a
  const [head = '', tail = ''] = a.split('::')
  const left = head ? head.split(':') : []
  const right = a.includes('::') && tail ? tail.split(':') : []
  const groups = a.includes('::')
    ? [...left, ...Array.from({ length: Math.max(0, 8 - left.length - right.length) }, () => '0'), ...right]
    : left
  return `${groups.slice(0, 4).map(g => (g || '0').replace(/^0+(?=.)/, '')).join(':')}::/64`
}

/**
 * Whether the address is from a private network: loopback, RFC 1918, CGNAT, link-local, IPv6 ULA
 * (including IPv4-mapped). Only such a neighbor — our own proxy, a Docker bridge — is trusted
 * for `X-Forwarded-For`.
 */
export function isPrivateAddress(ip: string): boolean {
  const a = unmapIPv4(String(ip ?? ''))
  const v4 = /^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(a)
  if (v4) {
    const o1 = Number(v4[1])
    const o2 = Number(v4[2])
    return o1 === 10 || o1 === 127
      || (o1 === 172 && o2 >= 16 && o2 <= 31)
      || (o1 === 192 && o2 === 168)
      || (o1 === 169 && o2 === 254)
      || (o1 === 100 && o2 >= 64 && o2 <= 127)
  }
  return a === '::1' || /^f[cd][0-9a-f]{2}:/.test(a) || /^fe[89ab][0-9a-f]:/.test(a)
}

/**
 * Client IP for rate limiting.
 *
 * Without a trusted proxy — the socket address. With one (`TRUST_PROXY=1`) — the LAST address in
 * `X-Forwarded-For`: our proxy appends it, and everything to its left came from the client. h3
 * (`getRequestIP` with `xForwardedFor`) takes the first — spoofable, which would let the limit be
 * bypassed by changing the header. The header is trusted only if the connection came from a
 * private network: if the server's port is exposed externally, a client reaching it around the
 * proxy could otherwise assign itself any address (finding of /code-review). The scheme assumes
 * exactly ONE proxy in front of the server (docs/DEPLOY.md).
 */
export function pickClientIp(forwardedFor: string | undefined | null, socketIp: string | undefined | null, trustProxy: boolean): string {
  if (forwardedStatus(forwardedFor, socketIp, trustProxy) === 'used') return lastForwarded(forwardedFor)
  return socketIp || 'unknown'
}

/** Last non-empty address in `X-Forwarded-For`; `''` — none present. */
function lastForwarded(forwardedFor: string | undefined | null): string {
  return String(forwardedFor ?? '').split(',').map(part => part.trim()).filter(Boolean).pop() ?? ''
}

export type ForwardedStatus = 'used' | 'ignored' | 'absent'

/**
 * Whether `X-Forwarded-For` was honored for this request: `used` — yes; `ignored` — the header is
 * present but not trusted (no `TRUST_PROXY=1`, or the proxy didn't come from a private network —
 * in which case all clients share the proxy address's limits); `absent` — no header at all.
 * Exposed via `/api/health`: otherwise a silently ignored header would go unnoticed (finding of
 * /code-review).
 */
export function forwardedStatus(forwardedFor: string | undefined | null, socketIp: string | undefined | null, trustProxy: boolean): ForwardedStatus {
  if (!lastForwarded(forwardedFor)) return 'absent'
  return trustProxy && !!socketIp && isPrivateAddress(socketIp) ? 'used' : 'ignored'
}
