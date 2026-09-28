// GET /api/health — whether the server is alive and configured. No secrets: just "set / not set" flags.

import { buildCommit } from '../utils/buildInfo'
import { forwardedStatus } from '../utils/requestLimits'

export default defineEventHandler(event => ({
  ok: true,
  // Commit of the running image, 7 characters — matches the `sha-…` tag used for rollback (null — local build).
  commit: buildCommit(process.env.COMMIT_SHA),
  config: {
    siteUrl: Boolean(useRuntimeConfig().public.siteUrl),
    oauth: Boolean(process.env.B24_CLIENT_ID && process.env.B24_CLIENT_SECRET),
    tokenKey: Boolean(process.env.B24_TOKEN_ENC_KEY),
    // Without an app code, the server refuses every frame request (503, server/utils/frameAuth.ts).
    appCode: Boolean(process.env.B24_APP_CODE?.trim()),
    trustProxy: process.env.TRUST_PROXY === '1'
  },
  // How the server sees THIS request's address (requestLimits.ts → forwardedStatus): request
  // health through your proxy — with TRUST_PROXY=1 this should read `used`.
  request: {
    forwardedFor: forwardedStatus(getRequestHeader(event, 'x-forwarded-for'), getRequestIP(event), process.env.TRUST_PROXY === '1')
  }
}))
