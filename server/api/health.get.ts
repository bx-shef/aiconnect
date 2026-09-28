// GET /api/health — жив ли сервер и сконфигурирован ли он. Без секретов: только флаги «задано / нет».

import { buildCommit } from '../utils/buildInfo'
import { forwardedStatus } from '../utils/requestLimits'

export default defineEventHandler(event => ({
  ok: true,
  // Коммит запущенного образа, 7 знаков — как в теге `sha-…` для отката (null — локальная сборка).
  commit: buildCommit(process.env.COMMIT_SHA),
  config: {
    siteUrl: Boolean(useRuntimeConfig().public.siteUrl),
    oauth: Boolean(process.env.B24_CLIENT_ID && process.env.B24_CLIENT_SECRET),
    tokenKey: Boolean(process.env.B24_TOKEN_ENC_KEY),
    // Без кода приложения сервер отказывает всем запросам из фрейма (503, server/utils/frameAuth.ts).
    appCode: Boolean(process.env.B24_APP_CODE?.trim()),
    trustProxy: process.env.TRUST_PROXY === '1',
    bitrixGpt: Boolean(process.env.BITRIXGPT_API_KEY || process.env.VIBE_API_KEY)
  },
  // Как сервер видит адрес ЭТОГО запроса (requestLimits.ts → forwardedStatus): запросите health
  // через свой прокси — при TRUST_PROXY=1 здесь должно быть `used`.
  request: {
    forwardedFor: forwardedStatus(getRequestHeader(event, 'x-forwarded-for'), getRequestIP(event), process.env.TRUST_PROXY === '1')
  }
}))
