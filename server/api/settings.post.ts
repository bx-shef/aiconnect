// POST /api/settings — сохранение общих настроек. Решение — `saveSettingsFor`
// (server/utils/optionWrites.ts, покрыт тестами): только администратор портала, его токеном.

import { installerCall, requireFrameUser } from '../utils/requestContext'
import { saveSettingsFor } from '../utils/optionWrites'

export default defineEventHandler(async (event) => {
  const { user, frameCall } = await requireFrameUser(event)
  const result = await saveSettingsFor({
    userId: user.userId,
    isAdmin: user.isAdmin,
    frameCall,
    installerCall: () => installerCall(user)
  }, await readBody(event))
  setResponseStatus(event, result.status)
  return result.body
})
