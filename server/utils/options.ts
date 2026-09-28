// Чтение и запись app.option с проверкой бюджета места (shared/domain/storageBudget.ts).

import { storageUsage, type StorageUsage } from '#shared/domain/storageBudget'
import type { RestCall } from './b24Client'

/** Все опции приложения как строки (так мы их и пишем). Не-строки сериализуем для подсчёта места. */
export async function readAllOptions(call: RestCall): Promise<Record<string, string>> {
  const result = await call('app.option.get')
  const out: Record<string, string> = {}
  if (result && typeof result === 'object' && !Array.isArray(result)) {
    for (const [key, value] of Object.entries(result as Record<string, unknown>)) {
      out[key] = typeof value === 'string' ? value : JSON.stringify(value ?? '')
    }
  }
  return out
}

/** Одна опция по ключу; `undefined` — ключа нет. */
export async function readOption(call: RestCall, key: string): Promise<unknown> {
  const result = await call('app.option.get', { option: key })
  return result ?? undefined
}

export interface WriteOutcome {
  ok: boolean
  usage: StorageUsage
}

/**
 * Пишет одну опцию, если после записи ВСЕ опции приложения укладываются в бюджет.
 * Считаем по всем ключам сразу: ставки и настройки делят одно место (гипотеза в storageBudget.ts).
 */
export async function writeOptionWithinBudget(read: RestCall, write: RestCall, key: string, value: string): Promise<WriteOutcome> {
  const all = await readAllOptions(read)
  const usage = storageUsage({ ...all, [key]: value })
  if (!usage.fits) return { ok: false, usage }
  await write('app.option.set', { options: { [key]: value } })
  return { ok: true, usage }
}
