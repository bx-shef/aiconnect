// POST /api/ai/names — названия строк счёта через BitrixGPT (режим названий «ИИ»).
// Разбор запроса — `parseNamingRequest` (server/utils/aiRequests.ts, покрыт тестами).
// Промпт берётся из настроек ПОРТАЛА (сервер читает app.option сам), а не из тела запроса:
// иначе эндпоинт превратился бы в бесплатный доступ к модели с любым системным промптом.

import { buildNamingMessages, pickNames } from '#shared/domain/prompts'
import { parseSettings, SETTINGS_KEY } from '#shared/domain/settings'
import { askBitrixGpt, enforceAiLimit } from '../../utils/aiGateway'
import { parseNamingRequest } from '../../utils/aiRequests'
import { extractJson } from '../../utils/llm'
import { readOption } from '../../utils/options'
import { aiHttpError, requireFrameUser } from '../../utils/requestContext'

export default defineEventHandler(async (event) => {
  const { user, frameCall } = await requireFrameUser(event)
  const parsed = parseNamingRequest(await readBody(event))
  if (!parsed.ok) throw createError({ statusCode: parsed.status, statusMessage: parsed.error })
  const { mode, items } = parsed.value

  try {
    // Лимит считается в строках (server/utils/rateLimit.ts): пакет весит столько, сколько в нём строк.
    enforceAiLimit(user, { weight: items.length })
    const settings = parseSettings(await readOption(frameCall, SETTINGS_KEY))
    const custom = mode === 'task' ? settings.prompts.taskTitle : settings.prompts.timeBlock
    const answer = await askBitrixGpt({ messages: buildNamingMessages(mode, custom, items), json: true })
    return { names: pickNames(extractJson(answer), items.map(i => i.key)) }
  } catch (e) {
    throw aiHttpError(e)
  }
})
