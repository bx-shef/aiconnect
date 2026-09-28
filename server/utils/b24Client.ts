// Server-side calls to the Bitrix24 REST API — via @bitrix24/b24jssdk (the B24OAuth class), as
// in the reference app client-bank-alfa-by (server/utils/b24Sdk.ts). Two kinds of client:
//   - by user frame token — that user's rights, the token cannot be refreshed;
//   - by the saved install token — installer-admin rights, with refresh.
// All outgoing methods are listed in docs/REST_METHODS.md.

import { B24OAuth } from '@bitrix24/b24jssdk'
import type { B24OAuthParams } from '@bitrix24/b24jssdk'
import { assertPortalHost, DEFAULT_OAUTH_HOST } from './b24Host'
import type { OAuthCreds } from './verifyInstallMember'

/** Calls a REST method: the envelope's `result`, or an exception with the portal's error text. */
export type RestCall = (method: string, params?: Record<string, unknown>) => Promise<unknown>

/** Message that signals the frame token was rejected (it cannot be refreshed server-side). */
export const FRAME_TOKEN_REJECTED = 'frame token rejected'

interface TokenInput {
  domain: string
  memberId: string
  accessToken: string
  refreshToken: string
  expiresAt: number
  applicationToken: string
  /** Portal's authorization server (from the portal record); unset — falls back to the default. */
  oauthHost?: string
}

/**
 * Builds B24OAuth params from our token record. The portal host passes through the SSRF guard.
 * The authorization server is the portal's own (from install's `auth[server_endpoint]`): the SDK
 * sends the refresh to `<serverEndpoint without /rest/>/oauth/token/`.
 */
export function oauthParams(token: TokenInput, nowMs: number): B24OAuthParams {
  const domain = assertPortalHost(token.domain)
  return {
    applicationToken: token.applicationToken,
    userId: 0,
    memberId: token.memberId,
    accessToken: token.accessToken,
    refreshToken: token.refreshToken,
    expires: Math.floor(token.expiresAt / 1000),
    expiresIn: Math.max(0, Math.floor((token.expiresAt - nowMs) / 1000)),
    scope: '',
    domain,
    clientEndpoint: `https://${domain}/rest/`,
    serverEndpoint: `https://${token.oauthHost || DEFAULT_OAUTH_HOST}/rest/`,
    status: 'L'
  }
}

/** Structural slice of the SDK client we call — tests pass in a fake. */
export interface SdkCallClient {
  actions: {
    v2: {
      call: {
        make: (o: { method: string, params?: Record<string, unknown> }) => Promise<{
          isSuccess: boolean
          getData: () => { result?: unknown } | undefined
          getErrorMessages: () => string[]
        }>
      }
    }
  }
}

/** Wraps a client as a `RestCall`: unwraps the envelope or throws with the portal's messages. */
export function restCallFrom(client: SdkCallClient): RestCall {
  return async (method, params = {}) => {
    const res = await client.actions.v2.call.make({ method, params })
    if (!res.isSuccess) throw new Error(`${method}: ${res.getErrorMessages().join('; ') || 'unknown error'}`)
    return res.getData()?.result
  }
}

/**
 * Client by frame token. The server has no refresh token of its own: any auth error is a final
 * rejection, not a "refresh me" (otherwise the SDK would POST an empty refresh_token).
 */
export function makeFrameCall(domain: string, accessToken: string, creds: OAuthCreds, nowMs = Date.now()): RestCall {
  const client = new B24OAuth(oauthParams({
    domain, memberId: '', accessToken, refreshToken: '', expiresAt: nowMs + 3_600_000, applicationToken: ''
  }, nowMs), creds)
  client.setCustomRefreshAuth(() => Promise.reject(new Error(FRAME_TOKEN_REJECTED)))
  return restCallFrom(client)
}

/**
 * Client by the saved install token. The SDK refreshes an expired access token itself and hands
 * the new tokens to `persist` — they must be saved, or the next call starts with the stale one.
 */
export function makePortalCall(
  token: TokenInput,
  creds: OAuthCreds,
  persist: (t: { accessToken: string, refreshToken: string, expiresAt: number }) => Promise<void>,
  nowMs = Date.now()
): RestCall {
  const client = new B24OAuth(oauthParams(token, nowMs), creds)
  client.setCallbackRefreshAuth(async ({ b24OAuthParams }) => {
    await persist({
      accessToken: b24OAuthParams.accessToken,
      refreshToken: b24OAuthParams.refreshToken,
      expiresAt: b24OAuthParams.expires * 1000
    })
  })
  return restCallFrom(client)
}

/** App's OAuth credentials from the environment; empty strings mean unset. */
export function oauthCredsFromEnv(env: Record<string, string | undefined> = process.env): OAuthCreds {
  return {
    clientId: env.B24_CLIENT_ID?.trim() || '',
    clientSecret: env.B24_CLIENT_SECRET?.trim() || ''
  }
}
