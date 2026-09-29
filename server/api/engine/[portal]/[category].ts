// completions_url of the stage 1 protocol spy: GET → 200 (Bitrix24 checks the URL on
// ai.engine.register), POST → capture, 202 at once, callback afterwards. Decisions are in
// server/utils/spy.ts (engineGate, handleEngineRequest — covered by tests); here only the body and
// live dependencies.

import { loadEncKey } from '../../../utils/secretCrypto'
import { engineGate, handleEngineRequest } from '../../../utils/spy'
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
  const getPortalDomain = async (id: string) => (await getPortal(kv, id))?.domain ?? null

  // Everything is checked before the body is read: up to 16 MB is buffered only for real portals where the spy is on.
  const gate = await engineGate(segment, category, event.method, {
    encKey,
    getPortalDomain,
    allow: memberId => windows.take([[`engine:${memberId}`, ENGINE_REQUESTS_PER_PORTAL]])
  })
  if (!gate.ok) throw createError({ statusCode: gate.status, statusMessage: gate.message })
  if (gate.answer === 'ready') return { ready: true }

  const verdict = await handleEngineRequest(segment, category, (await readRawBody(event)) || '', getRequestHeader(event, 'content-type') ?? '', {
    kv,
    encKey,
    getPortalDomain,
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
