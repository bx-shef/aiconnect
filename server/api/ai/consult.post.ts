// POST /api/ai/consult — запуск промпта консультации из настроек над данными счёта.
// Разбор запроса и выбор промпта — `parseConsultRequest`, `findConsultPrompt`
// (server/utils/aiRequests.ts, покрыты тестами): текст берётся из настроек портала по id. Ответ возвращается странице, а та кладёт его делом в счёт (правами
// сотрудника — crm.activity.configurable.add во фрейме, shared/domain/activity.ts).

import { buildConsultMessages } from '#shared/domain/prompts'
import { parseSettings, SETTINGS_KEY } from '#shared/domain/settings'
import { askBitrixGpt, enforceAiLimit } from '../../utils/aiGateway'
import { findConsultPrompt, parseConsultRequest } from '../../utils/aiRequests'
import { readOption } from '../../utils/options'
import { CONSULT_WEIGHT } from '../../utils/rateLimit'
import { aiHttpError, requireFrameUser } from '../../utils/requestContext'

export default defineEventHandler(async (event) => {
  const { user, frameCall } = await requireFrameUser(event)
  const request = parseConsultRequest(await readBody(event))
  if (!request.ok) throw createError({ statusCode: request.status, statusMessage: request.error })
  const settings = parseSettings(await readOption(frameCall, SETTINGS_KEY))
  const found = findConsultPrompt(settings, request.value.promptId)
  if (!found.ok) throw createError({ statusCode: found.status, statusMessage: found.error })
  const prompt = found.value
  const { context } = request.value

  try {
    enforceAiLimit(user, { weight: CONSULT_WEIGHT })
    const answer = await askBitrixGpt({ messages: buildConsultMessages(prompt.text, context), json: false })
    return { title: prompt.title, text: answer.trim() }
  } catch (e) {
    throw aiHttpError(e)
  }
})
