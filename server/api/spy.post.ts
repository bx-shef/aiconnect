// POST /api/spy — the admin switches the spy's answer mode (`error` / `echo`) or clears captures.

import { clearCaptures, isSpyMode, setSpyMode, spyAccessError } from '../utils/spy'
import { portalStore, requireFrameUser } from '../utils/requestContext'

export default defineEventHandler(async (event) => {
  const { user } = await requireFrameUser(event)
  const denied = spyAccessError(user.isAdmin, user.portal.domain)
  if (denied) throw createError({ statusCode: denied.status, statusMessage: denied.message })
  const body = await readBody<{ mode?: unknown, clear?: unknown }>(event).catch(() => null)
  const kv = portalStore()
  if (body?.clear === true) {
    await clearCaptures(kv, user.portal.memberId)
    return { ok: true }
  }
  if (!isSpyMode(body?.mode)) throw createError({ statusCode: 400, statusMessage: 'mode must be "error" or "echo"' })
  await setSpyMode(kv, user.portal.memberId, body.mode)
  return { ok: true }
})
