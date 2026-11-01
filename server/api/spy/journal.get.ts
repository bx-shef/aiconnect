// GET /api/spy/journal — full-text journal of the spy (B24_SPY_FULL=1 on the stand only), portal
// admin only. `?id=<id>` — one record; otherwise all records, `?scenario=<label>` narrows them.
// Records hold portal users' full prompts: auth and callback URLs are masked (spyJournal.ts).

import { spyAccessError } from '../../utils/spy'
import { exportJournal, getJournalEntry, parseJournalQuery, spyFullEnabled } from '../../utils/spyJournal'
import { portalStore, requireFrameUser } from '../../utils/requestContext'

export default defineEventHandler(async (event) => {
  const { user } = await requireFrameUser(event)
  const denied = spyAccessError(user.isAdmin, user.portal.domain)
  if (denied) throw createError({ statusCode: denied.status, statusMessage: denied.message })
  if (!spyFullEnabled()) throw createError({ statusCode: 403, statusMessage: 'full mode is off (B24_SPY_FULL)' })
  const q = parseJournalQuery(getQuery(event))
  const kv = portalStore()
  if (q.kind === 'bad') throw createError({ statusCode: 400, statusMessage: q.message })
  if (q.kind === 'all') return exportJournal(kv, user.portal.memberId, q.scenario)
  const entry = await getJournalEntry(kv, user.portal.memberId, q.id)
  if (!entry) throw createError({ statusCode: 404, statusMessage: 'no such record' })
  return entry
})
