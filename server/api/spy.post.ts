// POST /api/spy — the admin switches the spy's answer mode (`error` / `echo`) or clears captures.

import { clearCaptures, isSpyMode, setSpyMode } from '../utils/spy'
import { portalStore, requireFrameUser } from '../utils/requestContext'

export default defineEventHandler(async (event) => {
  const { user } = await requireFrameUser(event)
  if (!user.isAdmin) throw createError({ statusCode: 403, statusMessage: 'portal admin only' })
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
