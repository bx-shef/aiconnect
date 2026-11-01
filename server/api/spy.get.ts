// GET /api/spy — the protocol spy for the portal admin: completions_url per category, the answer
// mode and the captured requests. Admin only: captures hold fragments of portal users' prompts.

import { loadEncKey } from '../utils/secretCrypto'
import { ENGINE_CATEGORIES, getSpyMode, listCaptures, portalSegment, spyAccessError, spyCode, spyName } from '../utils/spy'
import { getScenario, journalSummary, spyFullEnabled } from '../utils/spyJournal'
import { portalStore, requireFrameUser } from '../utils/requestContext'

export default defineEventHandler(async (event) => {
  const { user } = await requireFrameUser(event)
  const denied = spyAccessError(user.isAdmin, user.portal.domain)
  // The page explains "off" instead of showing an error; a non-admin gets 403.
  if (denied?.reason === 'off') return { enabled: false, full: false, engines: [], mode: 'error', scenario: '', journal: null, captures: [] }
  if (denied) throw createError({ statusCode: denied.status, statusMessage: denied.message })
  const siteUrl = useRuntimeConfig().public.siteUrl || getRequestURL(event).origin
  const segment = portalSegment(user.portal.memberId, loadEncKey())
  const kv = portalStore()
  const full = spyFullEnabled()
  return {
    enabled: true,
    full,
    engines: ENGINE_CATEGORIES.map(category => ({
      category,
      code: spyCode(category),
      name: spyName(category),
      completionsUrl: new URL(`/api/engine/${segment}/${category}`, siteUrl).toString()
    })),
    mode: await getSpyMode(kv, user.portal.memberId),
    scenario: await getScenario(kv, user.portal.memberId),
    journal: full ? await journalSummary(kv, user.portal.memberId) : null,
    captures: await listCaptures(kv, user.portal.memberId)
  }
})
