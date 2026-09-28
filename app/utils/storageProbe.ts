// Замер предела app.option — «уточнить, сколько влезет» из ТЗ. Ядро — чистая функция с внедряемым
// REST-вызовом (тестируется на имитации портала: tests/storageProbe.test.ts); во фрейм её
// подключает composable useStorageProbe.ts. Запускает администратор из настроек (раздел
// «Хранилище»), надёжнее — на тестовом портале: docs/SETTINGS.md.
//
// Как работает: снимаем копию всех опций → пишем пробный ключ так, чтобы все опции заняли
// очередную ступень PROBE_LADDER → читаем всё обратно и сверяем. Первая неудача (ошибка записи,
// обрезанный пробный ключ, изменившийся чужой ключ) — стоп; если что-то испортилось,
// восстанавливаем копию. Итог — последняя удачная ступень, её сохраняем в STORAGE_KEY.

import { phpSerializedLength, PROBE_KEY, PROBE_LADDER, probeFiller, STORAGE_KEY, type MeasuredLimit } from '#shared/domain/storageBudget'

export interface ProbeStep {
  bytes: number
  ok: boolean
  note?: string
}

export interface ProbeResult {
  measured: MeasuredLimit
  steps: ProbeStep[]
  /** Была ли неудачная ступень (то есть найдена и верхняя граница). */
  hitLimit: boolean
  /** Пришлось ли восстанавливать копию опций. */
  restored: boolean
}

/** Опции как строки — в том же виде, в каком мы их пишем. */
function flatten(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {}
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
      out[key] = typeof value === 'string' ? value : JSON.stringify(value ?? '')
    }
  }
  return out
}

/** Остались ли все ключи копии нетронутыми (пробный ключ не в счёт). */
export function sameExceptProbe(before: Record<string, string>, after: Record<string, string>): boolean {
  return Object.entries(before).every(([key, value]) => key === PROBE_KEY || after[key] === value)
}

/** REST-вызов (метод, параметры) → результат; бросает при ошибке портала. */
export type ProbeCall = (method: string, params?: Record<string, unknown>) => Promise<unknown>

export async function runStorageProbe(call: ProbeCall, onStep?: (step: ProbeStep) => void, today = new Date().toISOString().slice(0, 10)): Promise<ProbeResult> {
  const readAll = async () => flatten(await call('app.option.get'))
  const backup = await readAll()
  const steps: ProbeStep[] = []
  let lastOk = phpSerializedLength({ ...backup, [PROBE_KEY]: '' })
  let hitLimit = false
  let restored = false

  for (const target of PROBE_LADDER) {
    const value = probeFiller(backup, target)
    if (value === null) continue
    const bytes = phpSerializedLength({ ...backup, [PROBE_KEY]: value })
    let step: ProbeStep
    try {
      await call('app.option.set', { options: { [PROBE_KEY]: value } })
      const after = await readAll()
      const intact = after[PROBE_KEY] === value && sameExceptProbe(backup, after)
      step = intact ? { bytes, ok: true } : { bytes, ok: false, note: 'данные прочитались не такими, какими записаны' }
    } catch (e) {
      step = { bytes, ok: false, note: e instanceof Error ? e.message : String(e) }
    }
    steps.push(step)
    onStep?.(step)
    if (!step.ok) {
      hitLimit = true
      break
    }
    lastOk = bytes
  }

  // Убираем пробные данные; если что-то из настроек пострадало — возвращаем копию целиком.
  await call('app.option.set', { options: { [PROBE_KEY]: '' } }).catch(() => undefined)
  const after = await readAll().catch(() => ({} as Record<string, string>))
  if (!sameExceptProbe(backup, after)) {
    const originals = Object.fromEntries(Object.entries(backup).filter(([key]) => key !== PROBE_KEY))
    await call('app.option.set', { options: originals })
    restored = true
  }

  const measured: MeasuredLimit = { limit: lastOk, at: today }
  await call('app.option.set', { options: { [STORAGE_KEY]: JSON.stringify(measured) } })
  return { measured, steps, hitLimit, restored }
}
