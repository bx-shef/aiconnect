// Замер предела app.option из фрейма: ядро — app/utils/storageProbe.ts.
// ⚠ Пишет администратор своим токеном прямо из фрейма (app.option.set ему разрешён). Сервер
// здесь не участвует: это диагностика, а не рабочий путь настроек.

import { runStorageProbe, type ProbeStep } from '~/utils/storageProbe'

export function useStorageProbe() {
  const b24 = useB24()
  return {
    run: (onStep?: (step: ProbeStep) => void) => runStorageProbe((method, params) => b24.call(method, params ?? {}), onStep)
  }
}
