// POST /api/spy — the admin switches the spy's answer mode (`error` / `echo`), sets the scenario
// label for the next requests, clears the short capture list or the full-text journal.

import { clearCaptures, isSpyMode, setSpyMode, spyAccessError } from '../utils/spy'
import { clearJournal, parseScenario, setScenario } from '../utils/spyJournal'
import { portalStore, requireFrameUser } from '../utils/requestContext'

export default defineEventHandler(async (event) => {
  const { user } = await requireFrameUser(event)
  const denied = spyAccessError(user.isAdmin, user.portal.domain)
  if (denied) throw createError({ statusCode: denied.status, statusMessage: denied.message })
  const body = await readBody<{ mode?: unknown, clear?: unknown, clearJournal?: unknown, scenario?: unknown }>(event).catch(() => null)
  const kv = portalStore()
  const memberId = user.portal.memberId
  if (body?.clear === true) {
    await clearCaptures(kv, memberId)
    return { ok: true }
  }
  if (body?.clearJournal === true) {
    await clearJournal(kv, memberId)
    return { ok: true }
  }
  if (body && 'scenario' in body) {
    const scenario = parseScenario(body.scenario)
    if (scenario === null) throw createError({ statusCode: 400, statusMessage: 'scenario: latin letters, digits, ".", "_", "-", up to 64 chars' })
    await setScenario(kv, memberId, scenario)
    return { ok: true, scenario }
  }
  if (!isSpyMode(body?.mode)) throw createError({ statusCode: 400, statusMessage: 'mode must be "error" or "echo"' })
  await setSpyMode(kv, memberId, body.mode)
  return { ok: true }
})
