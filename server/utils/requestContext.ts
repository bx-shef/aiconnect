// Shared scaffolding for API handlers: who made the request, and which Bitrix24 clients to serve
// them with. Uses Nitro auto-imports (useStorage, createError, getRequestHeaders), so it lives
// separately from the pure modules covered by unit tests.

import type { H3Event } from 'h3'
import { makeFrameCall, oauthCredsFromEnv, type RestCall } from './b24Client'
import { extractFrameAuth, verifyFrame, type FrameUser } from './frameAuth'
import { SlidingWindow } from './rateLimit'
import { FRAME_CHECKS_PER_IP, ipBucketKey, pickClientIp } from './requestLimits'
import type { KeyValue } from './tokenStore'

const frameCheckWindows = new SlidingWindow()

/** Client IP for rate limiting: `X-Forwarded-For` only when `TRUST_PROXY=1` (see `pickClientIp`). */
export function clientIp(event: H3Event): string {
  return pickClientIp(getRequestHeader(event, 'x-forwarded-for'), getRequestIP(event), process.env.TRUST_PROXY === '1')
}

/** Install store (fs driver, see `nitro.storage` in nuxt.config.ts). */
export function portalStore(): KeyValue {
  return useStorage('portals') as unknown as KeyValue
}

export interface RequestContext {
  user: FrameUser
  /** REST as the frame user — their rights. */
  frameCall: RestCall
}

/**
 * Verifies the request's frame token. Throws an h3 error with the right code if it can't be let
 * through. No handler currently calls this: stage 0 pages don't hit our /api with a token.
 * Kept alongside frameAuth as settings infrastructure (stage 3 of docs/PLAN.md).
 */
export async function requireFrameUser(event: H3Event): Promise<RequestContext> {
  const headers = getRequestHeaders(event)
  const auth = extractFrameAuth({ get: name => headers[name] })
  if (!auth) throw createError({ statusCode: 400, statusMessage: 'frame auth headers required' })
  const creds = oauthCredsFromEnv()
  const ip = clientIp(event)
  const verdict = await verifyFrame(auth, {
    kv: portalStore(),
    call: (domain, token, method) => makeFrameCall(domain, token, creds)(method),
    appCode: process.env.B24_APP_CODE?.trim() || '',
    // A live check is a call into the portal; a flood of random tokens must not drive us there without limit.
    allowLiveCheck: () => frameCheckWindows.take([[`fv:${ipBucketKey(ip)}`, FRAME_CHECKS_PER_IP]])
  })
  if (!verdict.ok) throw createError({ statusCode: verdict.status, statusMessage: verdict.error })
  return { user: verdict.user, frameCall: makeFrameCall(auth.domain, auth.accessToken, creds) }
}
