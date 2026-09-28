// POST /api/b24/events — входящие события портала: установка и удаление приложения.
// Решение принимает `handleB24Event` (server/utils/b24EventsHandler.ts, покрыт тестами); здесь —
// только чтение тела и живые зависимости. Контракт — docs/B24_EVENTS.md.

import { oauthCredsFromEnv } from '../../utils/b24Client'
import { handleB24Event } from '../../utils/b24EventsHandler'
import { SlidingWindow } from '../../utils/rateLimit'
import { clientIp, portalStore } from '../../utils/requestContext'
import { EVENTS_PER_IP, ipBucketKey, OAUTH_VERIFY_GLOBAL } from '../../utils/requestLimits'
import { rawOauthRefresh, type OAuthFetchFn } from '../../utils/verifyInstallMember'

const eventWindows = new SlidingWindow()

export default defineEventHandler(async (event) => {
  const creds = oauthCredsFromEnv()
  const ip = clientIp(event)
  try {
    const result = await handleB24Event((await readRawBody(event)) || '', {
      kv: portalStore(),
      envToken: process.env.B24_APPLICATION_TOKEN?.trim() || '',
      creds,
      refresh: rawOauthRefresh(globalThis.fetch as unknown as OAuthFetchFn, creds),
      allowEvent: () => eventWindows.take([[`ev:${ipBucketKey(ip)}`, EVENTS_PER_IP]]),
      allowVerification: () => eventWindows.take([['verify:*', OAUTH_VERIFY_GLOBAL]]),
      log: line => console.info(`[b24-events] ${line}`),
      warn: line => console.error(`[b24-events] ${line}`)
    })
    setResponseStatus(event, result.status)
    return result.body
  } catch (err) {
    // Текст ошибки может нести member_id, но не токены; наружу — только общий ответ.
    console.error(`[b24-events] handler error: ${(err as Error)?.message}`)
    setResponseStatus(event, 500)
    return { error: 'internal error' }
  }
})
