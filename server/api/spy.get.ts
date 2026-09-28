// GET /api/spy — the protocol spy for the portal admin: completions_url per category, the answer
// mode and the captured requests. Admin only: captures hold fragments of portal users' prompts.

import { loadEncKey } from '../utils/secretCrypto'
import { ENGINE_CATEGORIES, getSpyMode, listCaptures, portalSegment, spyAccessError, spyCode, spyName } from '../utils/spy'
import { portalStore, requireFrameUser } from '../utils/requestContext'

export default defineEventHandler(async (event) => {
  const { user } = await requireFrameUser(event)
  const denied = spyAccessError(user.isAdmin, user.portal.domain)
  // The page explains "off" instead of showing an error; a non-admin gets 403.
  if (denied?.reason === 'off') return { enabled: false, engines: [], mode: 'error', captures: [] }
  if (denied) throw createError({ statusCode: denied.status, statusMessage: denied.message })
  const siteUrl = useRuntimeConfig().public.siteUrl || getRequestURL(event).origin
  const segment = portalSegment(user.portal.memberId, loadEncKey())
  const kv = portalStore()
  return {
    enabled: true,
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
