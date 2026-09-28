// Decision logic for an incoming portal event — a pure function over injectable dependencies, so
// the install/uninstall branches can be fully covered by tests (finding from the panel's QA:
// the handler wasn't tested). The Nitro handler `server/api/b24/events.post.ts` only reads the
// body and wires in live dependencies. Contract — docs/B24_EVENTS.md.

import { assertPortalHost, resolveOAuthHost } from './b24Host'
import { appTokenVerdict, B24_EVENT_INSTALL, B24_EVENT_UNINSTALL, eventCode, parseBracketForm, parseEventAuth } from './b24Events'
import { getPortal, removePortal, saveInstall, type KeyValue } from './tokenStore'
import { verifyInstallMember, type OAuthCreds } from './verifyInstallMember'

export interface EventDeps {
  kv: KeyValue
  /** `B24_APPLICATION_TOKEN` from the environment, `''` — unset. */
  envToken: string
  creds: OAuthCreds
  /** Refreshes the refresh token on the authorization server `oauthHost` (verifyInstallMember.rawOauthRefresh). */
  refresh: (refreshToken: string, oauthHost: string) => Promise<unknown>
  /**
   * Sender address limit: whether an install or uninstall event can be processed; `false` — 429.
   * Checked ONLY for these two events: others cost nothing, and used to burn through this limit —
   * another portal, by subscribing our address to a flood of its events, could block other
   * portals' installs (finding of /code-review).
   */
  allowEvent?: () => boolean
  /**
   * Global cap on install verifications (`OAUTH_VERIFY_GLOBAL`): checked right before the request
   * to the authorization server, after all other checks; `false` — 429. Garbage and uninstalls
   * don't spend it.
   */
  allowVerification?: () => boolean
  /** Environment for the SSRF guard (`B24_SELFHOSTED_HOSTS`). */
  env?: Record<string, string | undefined>
  /** Log line (no tokens). */
  log?: (line: string) => void
  /** Error log line: what monitoring should alert on. */
  warn?: (line: string) => void
}

export interface EventResult {
  status: number
  body: Record<string, unknown>
}

/** Parses the event body and decides what to do. Never throws on untrusted input. */
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
    // From here on, always use the CLEAN host from the guard, not the raw input: frameAuth looks up by it too.
    domain = assertPortalHost(auth.domain, deps.env)
  } catch {
    return { status: 400, body: { error: 'malformed event' } }
  }

  if (code === B24_EVENT_UNINSTALL) {
    const stored = await getPortal(deps.kv, auth.memberId)
    const verdict = appTokenVerdict({ isInstall: false, incoming: auth.applicationToken, envToken: deps.envToken, storedToken: stored?.applicationToken })
    if (verdict !== 'accept') return { status: verdict === 'unconfigured' ? 503 : 403, body: { error: `application_token ${verdict}` } }
    // The app was uninstalled — keep nothing about this portal.
    await removePortal(deps.kv, auth.memberId)
    log(`uninstall member_id=${auth.memberId}`)
    return { status: 200, body: { ok: true } }
  }

  const verdict = appTokenVerdict({ isInstall: true, incoming: auth.applicationToken, envToken: deps.envToken })
  if (verdict !== 'accept') return { status: 403, body: { error: `application_token ${verdict}` } }

  // Warning: fail-closed without OAuth credentials. Measured 2026-09-24 (docs/B24_EVENTS.md):
  // without verification, a repeated "install" with the same member_id but SOMEONE ELSE'S tokens
  // would overwrite the portal's tokens.
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
