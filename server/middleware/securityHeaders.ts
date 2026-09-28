// Security headers for pages. The main one is `frame-ancestors`: the app's pages open inside the
// portal's frame, and only Bitrix24 portals (cloud zones and on-premise hosts from
// B24_SELFHOSTED_HOSTS) are allowed to embed them. We don't set X-Frame-Options — it would block the portal too.

import { frameAncestors } from '../utils/b24Host'

let cached: string | null = null

export default defineEventHandler((event) => {
  if (event.path.startsWith('/api/')) return
  cached ??= frameAncestors(process.env.B24_SELFHOSTED_HOSTS)
  setResponseHeader(event, 'Content-Security-Policy', cached)
  setResponseHeader(event, 'X-Content-Type-Options', 'nosniff')
  setResponseHeader(event, 'Referrer-Policy', 'strict-origin-when-cross-origin')
})
