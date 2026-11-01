// POST /api/spy — the admin switches the spy's answer mode (`error` / `echo`), sets the scenario
// label for the next requests, clears the short capture list or the full-text journal. The choice
// is `parseSpyPost` (spyJournal.ts, covered by tests).

import { clearCaptures, isSpyMode, setSpyMode, spyAccessError } from '../utils/spy'
import { clearJournal, parseSpyPost, setScenario } from '../utils/spyJournal'
import { portalStore, requireFrameUser } from '../utils/requestContext'

export default defineEventHandler(async (event) => {
  const { user } = await requireFrameUser(event)
  const denied = spyAccessError(user.isAdmin, user.portal.domain)
  if (denied) throw createError({ statusCode: denied.status, statusMessage: denied.message })
  const body = await readBody<Record<string, unknown>>(event).catch(() => null)
  const kv = portalStore()
  const memberId = user.portal.memberId
  const action = parseSpyPost(body && typeof body === 'object' ? body : null)
  switch (action.kind) {
    case 'clear':
      await clearCaptures(kv, memberId)
      return { ok: true }
    case 'clearJournal':
      await clearJournal(kv, memberId)
      return { ok: true }
    case 'scenario':
      await setScenario(kv, memberId, action.scenario)
      return { ok: true, scenario: action.scenario }
    case 'bad':
      throw createError({ statusCode: 400, statusMessage: action.message })
    case 'mode':
      if (!isSpyMode(action.mode)) throw createError({ statusCode: 400, statusMessage: 'mode must be "error" or "echo"' })
      await setSpyMode(kv, memberId, action.mode)
      return { ok: true }
  }
})
