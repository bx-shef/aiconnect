// Пределы тела запросов к /api (server/utils/requestLimits.ts). Частота событий установки
// считается в самом обработчике — после разбора кода события (server/utils/b24EventsHandler.ts):
// middleware тело не читает и не отличила бы установку от потока посторонних событий.

import { bodyLimitFor, checkBodySize } from '../utils/requestLimits'

export default defineEventHandler((event) => {
  const limit = bodyLimitFor(event.method, event.path)
  if (limit === null) return
  const verdict = checkBodySize(getRequestHeader(event, 'content-length'), limit)
  if (!verdict.ok) throw createError({ statusCode: verdict.status, statusMessage: verdict.status === 413 ? 'payload too large' : 'content-length required' })
})
