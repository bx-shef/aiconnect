// Frame token verification: who sent this request to our /api.
//
// The browser sends `Authorization: Bearer <frame access_token>` and `X-B24-Domain: <portal>`
// (app/composables/useApi.ts). The server does NOT take any field on faith:
//   1) the domain passes the SSRF guard and must belong to an install in our store —
//      otherwise our API would be open to any Bitrix24 portal;
//   2) the token is checked with a live `profile` call (who this is and whether they're admin);
//   3) the token must belong to OUR app (`app.info.CODE` = `B24_APP_CODE`): a frame token from
//      another app on the same portal would also pass `profile`. Without `B24_APP_CODE` the
//      server refuses (503) rather than skip the check — finding from the panel's security team;
//   4) live checks are rate-limited (`allowLiveCheck`): otherwise a flood of random tokens would
//      drive our server to call `profile` against someone else's portal without limit.
// The scheme follows the reference apps (resolveFrameMember.ts / settingsHandler.ts), plus points 3-4.

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

/** Request headers → domain and token. `null` — something's missing, or the domain isn't a Bitrix24 portal. */
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
  /** REST call made as the frame token (b24Client.makeFrameCall). */
  call: (domain: string, accessToken: string, method: string) => Promise<unknown>
  /** Our app's code (`B24_APP_CODE`); empty — refuse with 503 rather than skip the check. */
  appCode: string
  /** Whether a live check against the portal is allowed right now; `false` — 429. Default: allowed. */
  allowLiveCheck?: () => boolean
  now?: () => number
}

/** Verification cache: the same token isn't re-checked against the portal on every request. Keyed by token hash. */
const cache = new Map<string, { until: number, verdict: FrameVerdict }>()
export const VERIFY_CACHE_MS = 60_000
export const VERIFY_CACHE_MAX = 5000

/**
 * Remembers a verdict. When the cache is full, expired entries are dropped first, then the
 * oldest ones down to 90% of the cap. The cache used to be cleared ENTIRELY: all employees would
 * hit the live check at once and run into its per-IP limit — spurious 429s (finding from the
 * panel's security team).
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
  // Delete and re-insert: `set` on an existing key would leave it in its old position, so a
  // freshly re-verified token would be the first to be evicted (finding of /code-review).
  cache.delete(key)
  cache.set(key, entry)
}

function cacheKey(auth: FrameAuth): string {
  return createHash('sha256').update(`${auth.domain}|${auth.accessToken}`).digest('hex')
}

/** For tests: reset the cache between scenarios. */
export function resetFrameCache(): void {
  cache.clear()
}

/** For tests: how many verdicts are currently cached. */
export function frameCacheSize(): number {
  return cache.size
}

/** Whether an exception looks like an auth rejection (rather than a network/portal failure). */
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
