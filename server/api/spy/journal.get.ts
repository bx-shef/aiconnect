// GET /api/spy/journal — full-text journal of the spy (B24_SPY_FULL=1 on the stand only), portal
// admin only. `?id=<id>` — one record; otherwise all records, `?scenario=<label>` narrows them.
// Records hold portal users' full prompts: auth and callback URLs are masked (spyJournal.ts).

import { spyAccessError } from '../../utils/spy'
import { exportJournal, getJournalEntry, parseScenario, spyFullEnabled } from '../../utils/spyJournal'
import { portalStore, requireFrameUser } from '../../utils/requestContext'

export default defineEventHandler(async (event) => {
  const { user } = await requireFrameUser(event)
  const denied = spyAccessError(user.isAdmin, user.portal.domain)
  if (denied) throw createError({ statusCode: denied.status, statusMessage: denied.message })
  if (!spyFullEnabled(true)) throw createError({ statusCode: 403, statusMessage: 'full mode is off (B24_SPY_FULL)' })
  const query = getQuery(event)
  const kv = portalStore()
  if (typeof query.id === 'string' && query.id) {
    const entry = await getJournalEntry(kv, user.portal.memberId, query.id)
    if (!entry) throw createError({ statusCode: 404, statusMessage: 'no such record' })
    return entry
  }
  const scenario = parseScenario(query.scenario)
  if (scenario === null) throw createError({ statusCode: 400, statusMessage: 'bad scenario' })
  return exportJournal(kv, user.portal.memberId, scenario)
})
