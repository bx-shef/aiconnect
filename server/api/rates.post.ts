// POST /api/rates — сохранение ставок часа: администратор или сотрудник из `rateEditors` (ТЗ).
// Решение — `saveRatesFor` (server/utils/optionWrites.ts, покрыт тестами).
//
// ⚠ Почему через сервер. app.option.set доступен ТОЛЬКО администратору (документация метода,
// ошибка «Administrator authorization required»). Назначенный редактор ставок не администратор —
// его токеном записать нельзя, поэтому сервер пишет токеном администратора-установщика.

import { installerCall, requireFrameUser } from '../utils/requestContext'
import { saveRatesFor } from '../utils/optionWrites'

export default defineEventHandler(async (event) => {
  const { user, frameCall } = await requireFrameUser(event)
  const result = await saveRatesFor({
    userId: user.userId,
    isAdmin: user.isAdmin,
    frameCall,
    installerCall: () => installerCall(user)
  }, await readBody(event))
  if (result.status === 200) console.info(`[rates] saved by user=${user.userId} admin=${user.isAdmin} entries=${result.body.entries}`)
  setResponseStatus(event, result.status)
  return result.body
})
