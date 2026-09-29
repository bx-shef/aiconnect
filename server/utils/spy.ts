// Stage 1 protocol spy (docs/PLAN.md): Bitrix24 sends BitrixGPT requests to our completions_url;
// the spy records what arrives (masked and truncated), answers 202 and then reports an error (or a
// test answer) to the callback, so the portal is not left waiting. Pure functions: the handler
// (server/api/engine/[portal]/[category].ts) only reads the body and passes live dependencies.
// Protocol as documented — docs/RESEARCH.md; what the spy learns goes to docs/PROTOCOL.md.

import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto'
import { isAllowedPortalHost, parseSelfHostedHosts } from './b24Host'
import type { KeyValue } from './tokenStore'

/** Categories accepted by `ai.engine.register` (docs; `vision` confirmed on the test portal). */
export const ENGINE_CATEGORIES = ['text', 'image', 'audio', 'call', 'vision', 'classify'] as const
export type EngineCategory = typeof ENGINE_CATEGORIES[number]

export function isEngineCategory(value: unknown): value is EngineCategory {
  return typeof value === 'string' && (ENGINE_CATEGORIES as readonly string[]).includes(value)
}

/**
 * Portal segment of completions_url: `<member_id>.<signature>`. The signature is an HMAC of the
 * member_id with a key derived from B24_TOKEN_ENC_KEY, so nobody can forge a URL for someone
 * else's portal, and the request body (whose `auth` shape is still unmeasured) is not trusted to
 * say which portal it came from.
 */
export function portalSegment(memberId: string, encKey: Buffer): string {
  return `${memberId.toLowerCase()}.${signature(memberId, encKey)}`
}

function signature(memberId: string, encKey: Buffer): string {
  return createHmac('sha256', encKey).update(`aiconnect-engine:${memberId.toLowerCase()}`).digest('base64url').slice(0, 22)
}

/** member_id from a valid portal segment; `null` for a malformed or forged one. */
export function memberIdFromSegment(segment: string, encKey: Buffer): string | null {
  const m = /^([0-9a-z]{1,64})\.([\w-]{22})$/i.exec(segment ?? '')
  if (!m) return null
  const expected = Buffer.from(signature(m[1]!, encKey))
  const actual = Buffer.from(m[2]!)
  return expected.length === actual.length && timingSafeEqual(expected, actual) ? m[1]!.toLowerCase() : null
}

/** Provider code the spy registers under; kept apart from the product codes `sh_aiconnect_<category>`. */
export const spyCode = (category: EngineCategory) => `sh_aiconnect_spy_${category}`
/** Provider name shown in the Bitrix24 model selectors. */
export const spyName = (category: EngineCategory) => `TEST ${category}`

/** Longest string kept in a capture; longer ones are cut and their full length recorded. */
export const CAPTURE_STRING_LIMIT = 500
/** Captures kept per portal, newest first. */
export const CAPTURES_PER_PORTAL = 50
const MAX_DEPTH = 6
const MAX_KEYS = 100

/**
 * Masked copy of a request body for the capture log. `auth` values are replaced by their type
 * and length (they are credentials); strings longer than {@link CAPTURE_STRING_LIMIT} are cut
 * with the original length noted; depth and key count are bounded so a hostile body cannot blow
 * up storage.
 */
export function sanitizeForCapture(value: unknown, depth = 0, key = ''): unknown {
  if (key === 'auth' && value !== null && value !== undefined) return maskAuth(value)
  if (typeof value === 'string') {
    return value.length > CAPTURE_STRING_LIMIT ? `${value.slice(0, CAPTURE_STRING_LIMIT)}… [${value.length} chars]` : value
  }
  if (value === null || typeof value !== 'object') return value
  if (depth >= MAX_DEPTH) return '[depth limit]'
  if (Array.isArray(value)) {
    const items = value.slice(0, MAX_KEYS).map(v => sanitizeForCapture(v, depth + 1))
    return value.length > MAX_KEYS ? [...items, `[+${value.length - MAX_KEYS} items]`] : items
  }
  const out: Record<string, unknown> = {}
  const entries = Object.entries(value as Record<string, unknown>)
  for (const [k, v] of entries.slice(0, MAX_KEYS)) out[k] = sanitizeForCapture(v, depth + 1, k)
  if (entries.length > MAX_KEYS) out['[more keys]'] = entries.length - MAX_KEYS
  return out
}

/**
 * Size budget of one stored capture (serialized). Per-string and per-level limits alone still let
 * a wide body of short strings through almost whole, and every capture rewrites the portal's list
 * on disk (finding of the security reviewer). Over budget, the capture keeps a cut JSON preview.
 */
export const CAPTURE_BUDGET_CHARS = 16_000

export function fitCaptureBudget(sanitized: unknown): unknown {
  const json = JSON.stringify(sanitized) ?? ''
  if (json.length <= CAPTURE_BUDGET_CHARS) return sanitized
  return { '[over budget]': `${json.length} chars`, 'preview': json.slice(0, CAPTURE_BUDGET_CHARS) }
}

/**
 * Portals where the spy works: `B24_SPY_PORTALS` — domains, comma or space separated. Empty means
 * nowhere. The spy is a stage 1 diagnostic, not a product feature: on any other portal the page
 * says it is off and the endpoint answers 404, so a client's admin never gets "TEST …" providers
 * and their users' prompts are never stored (finding of the technical director).
 */
export function spyEnabledFor(domain: string, env: Record<string, string | undefined> = process.env): boolean {
  return parseSelfHostedHosts(env.B24_SPY_PORTALS).has(domain.toLowerCase())
}

/** Who may use /api/spy: the portal admin, on a portal where the spy is on. `null` — allowed. */
export function spyAccessError(isAdmin: boolean, domain: string, env: Record<string, string | undefined> = process.env): { status: 403, reason: 'not-admin' | 'off', message: string } | null {
  if (!isAdmin) return { status: 403, reason: 'not-admin', message: 'portal admin only' }
  if (!spyEnabledFor(domain, env)) return { status: 403, reason: 'off', message: 'spy is off for this portal' }
  return null
}

export interface GateDeps {
  encKey: Buffer
  getPortalDomain: (memberId: string) => Promise<string | null>
  /** Rate limit per portal (a SlidingWindow in the handler); `false` — over the limit. */
  allow: (memberId: string) => boolean
  env?: Record<string, string | undefined>
}

export type GateVerdict = { ok: true, answer: 'ready' | 'read-body', memberId: string } | { ok: false, status: 404 | 405 | 429, message: string }

/**
 * What the completions_url handler does before reading any body: signature, category, install and
 * spy allow-list → 404; GET/HEAD (the registration check) → ready; other methods → 405; over the
 * per-portal rate → 429. Only then may up to 16 MB be read.
 */
export async function engineGate(segment: string, category: string, method: string, deps: GateDeps): Promise<GateVerdict> {
  const memberId = memberIdFromSegment(segment, deps.encKey)
  const domain = memberId && isEngineCategory(category) ? await deps.getPortalDomain(memberId) : null
  if (!memberId || !domain || !spyEnabledFor(domain, deps.env)) return { ok: false, status: 404, message: 'unknown endpoint' }
  const m = method.toUpperCase()
  if (m === 'GET' || m === 'HEAD') return { ok: true, answer: 'ready', memberId }
  if (m !== 'POST') return { ok: false, status: 405, message: 'method not allowed' }
  if (!deps.allow(memberId)) return { ok: false, status: 429, message: 'too many requests' }
  return { ok: true, answer: 'read-body', memberId }
}

/** `auth` shape without secrets: every leaf becomes `<type:length>`, keys stay visible. */
function maskAuth(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value
  if (typeof value === 'string') return `<string:${value.length}>`
  if (typeof value !== 'object') return `<${typeof value}>`
  if (depth >= MAX_DEPTH) return '[depth limit]'
  if (Array.isArray(value)) return value.slice(0, MAX_KEYS).map(v => maskAuth(v, depth + 1))
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(value as Record<string, unknown>).slice(0, MAX_KEYS)) out[k] = maskAuth(v, depth + 1)
  return out
}

/** How the spy answers after 202: report an error (default) or send a fixed test answer. */
export type SpyMode = 'error' | 'echo'
export const isSpyMode = (v: unknown): v is SpyMode => v === 'error' || v === 'echo'

/** Callback target check: https, a Bitrix24 portal host (SSRF guard), and whether it is this portal. */
export type CallbackVerdict = { ok: true, url: string, host: string, samePortal: boolean } | { ok: false, reason: string }

export function checkCallbackUrl(raw: unknown, portalDomain: string, env: Record<string, string | undefined> = process.env): CallbackVerdict {
  if (typeof raw !== 'string' || !raw) return { ok: false, reason: 'missing' }
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return { ok: false, reason: 'not a URL' }
  }
  if (url.protocol !== 'https:') return { ok: false, reason: 'not https' }
  if (url.username || url.password) return { ok: false, reason: 'credentials in URL' }
  if (url.port && url.port !== '443') return { ok: false, reason: 'non-default port' }
  const host = url.hostname.toLowerCase()
  if (!isAllowedPortalHost(host, parseSelfHostedHosts(env.B24_SELFHOSTED_HOSTS))) return { ok: false, reason: 'not a Bitrix24 host' }
  return { ok: true, url: url.toString(), host, samePortal: host === portalDomain.toLowerCase() }
}

/** Error callback body (docs): `api_request_completed: false` — no provider was called, the portal gets its quota back. */
export function errorCallbackBody(): { message: string, code: number, api_request_completed: false } {
  return { message: 'aiconnect protocol spy: request recorded, no model is connected yet', code: 503, api_request_completed: false }
}

/**
 * Success callback body for the `echo` mode. Text-like categories get a string; the reference
 * endpoint from Bitrix24 (docs/RESEARCH.md) sends an array for text too, of which the first item
 * is used. `image` expects image URLs, which the spy does not have — it reports an error instead.
 */
export function echoCallbackBody(category: EngineCategory): { result: string } | null {
  if (category === 'image') return null
  return { result: `aiconnect: тестовый ответ шпиона протокола (категория ${category}).` }
}

/** One captured request as stored and shown to the portal admin. */
export interface Capture {
  /** Random id: two requests of one category can share the same millisecond (finding of the panel). */
  id: string
  at: string
  category: string
  /** Top-level keys as received — the protocol shape at a glance. */
  keys: string[]
  bodyBytes: number
  contentType: string
  body: unknown
  callback: { target: 'errorCallbackUrl' | 'callbackUrl' | 'none', host?: string, samePortal?: boolean, status?: number, error?: string }
}

const capturesKey = (memberId: string) => `spy:${memberId.toLowerCase()}`
const modeKey = (memberId: string) => `spymode:${memberId.toLowerCase()}`

/**
 * Per-portal serialization of read-modify-write on the capture list: without it a callback's
 * update, finishing after 202, could overwrite a capture added in between (finding of
 * /code-review). One process holds the store (docs/ARCHITECTURE.md), so an in-memory chain is enough.
 */
const locks = new Map<string, Promise<void>>()
async function withLock(memberId: string, fn: () => Promise<void>): Promise<void> {
  const key = memberId.toLowerCase()
  const prev = locks.get(key) ?? Promise.resolve()
  const next = prev.then(fn, fn)
  const settled = next.catch(() => undefined)
  locks.set(key, settled)
  try {
    await next
  } finally {
    if (locks.get(key) === settled) locks.delete(key)
  }
}

export async function listCaptures(kv: KeyValue, memberId: string): Promise<Capture[]> {
  const value = await kv.getItem(capturesKey(memberId))
  return Array.isArray(value) ? value as Capture[] : []
}

/** Adds a capture on top and keeps the newest {@link CAPTURES_PER_PORTAL}. */
export async function addCapture(kv: KeyValue, memberId: string, capture: Capture): Promise<void> {
  await withLock(memberId, async () => {
    const prev = await listCaptures(kv, memberId)
    await kv.setItem(capturesKey(memberId), [capture, ...prev].slice(0, CAPTURES_PER_PORTAL))
  })
}

/** Replaces a stored capture (matched by id) — used to record the callback outcome. */
export async function updateCapture(kv: KeyValue, memberId: string, capture: Capture): Promise<void> {
  await withLock(memberId, async () => {
    const list = await listCaptures(kv, memberId)
    const i = list.findIndex(c => c.id === capture.id)
    if (i < 0) return
    list[i] = capture
    await kv.setItem(capturesKey(memberId), list)
  })
}

/** Drops the captures only (the admin's "clear" button). */
export async function clearCaptures(kv: KeyValue, memberId: string): Promise<void> {
  await withLock(memberId, () => kv.removeItem(capturesKey(memberId)))
}

/** Drops everything the spy keeps for a portal (app uninstall). */
export async function clearSpyData(kv: KeyValue, memberId: string): Promise<void> {
  await clearCaptures(kv, memberId)
  await kv.removeItem(modeKey(memberId))
}

export async function getSpyMode(kv: KeyValue, memberId: string): Promise<SpyMode> {
  const value = await kv.getItem(modeKey(memberId))
  return isSpyMode(value) ? value : 'error'
}

export async function setSpyMode(kv: KeyValue, memberId: string, mode: SpyMode): Promise<void> {
  await kv.setItem(modeKey(memberId), mode)
}

/** Posts a JSON callback; never throws — returns the status or the error text for the capture. */
export type PostJson = (url: string, body: unknown) => Promise<{ status: number }>

export interface HandleDeps {
  kv: KeyValue
  encKey: Buffer
  getPortalDomain: (memberId: string) => Promise<string | null>
  postJson: PostJson
  now?: () => Date
  log?: (line: string) => void
  env?: Record<string, string | undefined>
}

export type EngineVerdict = { status: 202, body: { result: 'OK' }, followUp: () => Promise<void> } | { status: 400 | 404, body: { error: string } }

/**
 * Decision on one POST to completions_url. Returns 202 at once (Bitrix24 waits at most 5 s) and a
 * `followUp` that sends the callback and records its outcome; the handler runs it without awaiting.
 */
export async function handleEngineRequest(segment: string, category: string, raw: string, contentType: string, deps: HandleDeps): Promise<EngineVerdict> {
  const memberId = memberIdFromSegment(segment, deps.encKey)
  if (!memberId || !isEngineCategory(category)) return { status: 404, body: { error: 'unknown endpoint' } }
  const domain = await deps.getPortalDomain(memberId)
  if (!domain) return { status: 404, body: { error: 'portal not installed' } }
  if (!spyEnabledFor(domain, deps.env)) return { status: 404, body: { error: 'spy is off for this portal' } }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    parsed = undefined
  }
  const body = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null
  const capture: Capture = {
    id: randomUUID(),
    at: (deps.now?.() ?? new Date()).toISOString(),
    category,
    keys: body ? Object.keys(body) : [],
    bodyBytes: Buffer.byteLength(raw),
    contentType,
    body: fitCaptureBudget(body ? sanitizeForCapture(body) : sanitizeForCapture(raw)),
    callback: { target: 'none' }
  }
  await addCapture(deps.kv, memberId, capture)
  // Structure only: prompts and answers never go to the log (CLAUDE.md, secrets and texts).
  deps.log?.(`[engine] ${memberId} ${category} ${capture.bodyBytes}B keys=${capture.keys.join(',')}`)
  if (!body) return { status: 400, body: { error: 'JSON object expected' } }

  const mode = await getSpyMode(deps.kv, memberId)
  const echo = mode === 'echo' ? echoCallbackBody(category) : null
  const target = echo ? 'callbackUrl' : 'errorCallbackUrl'
  const verdict = checkCallbackUrl(body[target], domain, deps.env)
  return {
    status: 202,
    body: { result: 'OK' },
    followUp: async () => {
      if (!verdict.ok) {
        capture.callback = { target: 'none', error: `${target}: ${verdict.reason}` }
      } else if (!verdict.samePortal) {
        // Recorded for the protocol, not called: our server only posts back to the portal that sent the request.
        capture.callback = { target: 'none', host: verdict.host, samePortal: false, error: `${target}: host differs from the portal` }
      } else {
        capture.callback = { target, host: verdict.host, samePortal: verdict.samePortal }
        try {
          capture.callback.status = (await deps.postJson(verdict.url, echo ?? errorCallbackBody())).status
        } catch (e) {
          capture.callback.error = e instanceof Error ? e.message.slice(0, 200) : 'callback failed'
        }
      }
      await updateCapture(deps.kv, memberId, capture)
    }
  }
}
