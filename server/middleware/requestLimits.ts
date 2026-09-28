// Body limits for /api requests (server/utils/requestLimits.ts). The rate of install events is
// counted in the handler itself — after the event code is parsed (server/utils/b24EventsHandler.ts):
// this middleware doesn't read the body, so it couldn't tell an install apart from a flood of
// unrelated events.

import { bodyLimitFor, checkBodySize } from '../utils/requestLimits'

export default defineEventHandler((event) => {
  const limit = bodyLimitFor(event.method, event.path)
  if (limit === null) return
  const verdict = checkBodySize(getRequestHeader(event, 'content-length'), limit)
  if (!verdict.ok) throw createError({ statusCode: verdict.status, statusMessage: verdict.status === 413 ? 'payload too large' : 'content-length required' })
})
