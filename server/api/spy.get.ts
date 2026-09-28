// GET /api/spy — the protocol spy for the portal admin: completions_url per category, the answer
// mode and the captured requests. Admin only: captures hold fragments of portal users' prompts.

import { loadEncKey } from '../utils/secretCrypto'
import { ENGINE_CATEGORIES, getSpyMode, listCaptures, portalSegment, spyCode, spyName } from '../utils/spy'
import { portalStore, requireFrameUser } from '../utils/requestContext'

export default defineEventHandler(async (event) => {
  const { user } = await requireFrameUser(event)
  if (!user.isAdmin) throw createError({ statusCode: 403, statusMessage: 'portal admin only' })
  const siteUrl = useRuntimeConfig().public.siteUrl || getRequestURL(event).origin
  const segment = portalSegment(user.portal.memberId, loadEncKey())
  const kv = portalStore()
  return {
    engines: ENGINE_CATEGORIES.map(category => ({
      category,
      code: spyCode(category),
      name: spyName(category),
      completionsUrl: new URL(`/api/engine/${segment}/${category}`, siteUrl).toString()
    })),
    mode: await getSpyMode(kv, user.portal.memberId),
    captures: await listCaptures(kv, user.portal.memberId)
  }
})
