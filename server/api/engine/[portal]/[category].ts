// completions_url of the stage 1 protocol spy: GET → 200 (Bitrix24 checks the URL on
// ai.engine.register), POST → capture, 202 at once, callback afterwards. Decisions are in
// server/utils/spy.ts (covered by tests); here only the body and live dependencies.

import { loadEncKey } from '../../../utils/secretCrypto'
import { handleEngineRequest, isEngineCategory, memberIdFromSegment } from '../../../utils/spy'
import { SlidingWindow } from '../../../utils/rateLimit'
import { portalStore } from '../../../utils/requestContext'
import { ENGINE_REQUESTS_PER_PORTAL } from '../../../utils/requestLimits'
import { getPortal } from '../../../utils/tokenStore'

const windows = new SlidingWindow()
const CALLBACK_TIMEOUT_MS = 10_000

export default defineEventHandler(async (event) => {
  const segment = getRouterParam(event, 'portal') ?? ''
  const category = getRouterParam(event, 'category') ?? ''
  const encKey = loadEncKey()
  const kv = portalStore()

  if (event.method === 'GET' || event.method === 'HEAD') {
    const memberId = memberIdFromSegment(segment, encKey)
    if (!memberId || !isEngineCategory(category) || !(await getPortal(kv, memberId))) throw createError({ statusCode: 404, statusMessage: 'unknown endpoint' })
    return { ready: true }
  }
  if (event.method !== 'POST') throw createError({ statusCode: 405, statusMessage: 'method not allowed' })

  // Signature and install are checked before the body is read: up to 16 MB is buffered only for real portals.
  const memberId = memberIdFromSegment(segment, encKey)
  if (!memberId || !isEngineCategory(category) || !(await getPortal(kv, memberId))) throw createError({ statusCode: 404, statusMessage: 'unknown endpoint' })
  if (!windows.take([[`engine:${memberId}`, ENGINE_REQUESTS_PER_PORTAL]])) {
    throw createError({ statusCode: 429, statusMessage: 'too many requests' })
  }
  const verdict = await handleEngineRequest(segment, category, (await readRawBody(event)) || '', getRequestHeader(event, 'content-type') ?? '', {
    kv,
    encKey,
    getPortalDomain: async id => (await getPortal(kv, id))?.domain ?? null,
    postJson: async (url, body) => {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        redirect: 'manual',
        signal: AbortSignal.timeout(CALLBACK_TIMEOUT_MS)
      })
      return { status: res.status }
    },
    log: line => console.info(line)
  })
  setResponseStatus(event, verdict.status)
  if (verdict.status === 202) {
    // Not awaited: Bitrix24 expects 202 within 5 s; the callback follows on its own.
    const pending = verdict.followUp().catch(e => console.error(`[engine] follow-up failed: ${(e as Error)?.message}`))
    event.waitUntil?.(pending)
  }
  return verdict.body
})
