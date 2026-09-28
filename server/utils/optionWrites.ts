// Запись настроек и ставок: кто может и КАКИМ токеном пишем. Чистые функции над внедряемыми
// REST-вызовами — тест проверяет, что ставки редактора уходят токеном установщика, а не его
// собственным, и что список редакторов берётся из портала, а не из запроса (находка тестировщика
// панели: обработчики не тестировались). Nitro-обработчики только подставляют живые вызовы.

import { coerceRateEntries, parseRates, serializeRates, validateRates } from '#shared/domain/rates'
import { canEditRates, parseSettings, RATES_KEY, serializeSettings, SETTINGS_KEY } from '#shared/domain/settings'
import type { RestCall } from './b24Client'
import { readOption, writeOptionWithinBudget } from './options'

export interface WriteContext {
  userId: number
  isAdmin: boolean
  /** REST от имени сотрудника (его фрейм-токен). */
  frameCall: RestCall
  /** REST от имени администратора-установщика; создаётся лениво — нужен не всегда. */
  installerCall: () => RestCall
}

export interface WriteResult {
  status: number
  body: Record<string, unknown>
}

/** Общие настройки: только администратор, его же токеном (app.option.set разрешён только ему). */
export async function saveSettingsFor(ctx: WriteContext, body: unknown): Promise<WriteResult> {
  if (!ctx.isAdmin) return { status: 403, body: { error: 'settings write requires a portal administrator' } }
  const raw = (body as { settings?: unknown } | null)?.settings
  // Пустое тело — не повод сбросить настройки портала к умолчаниям.
  if (!raw || typeof raw !== 'object') return { status: 400, body: { error: 'settings required' } }
  const value = serializeSettings(parseSettings(raw))
  const outcome = await writeOptionWithinBudget(ctx.frameCall, ctx.frameCall, SETTINGS_KEY, value)
  return outcome.ok
    ? { status: 200, body: { ok: true, usage: outcome.usage } }
    : { status: 413, body: { error: 'storage budget exceeded', usage: outcome.usage } }
}

/**
 * Ставки: администратор — своим токеном; сотрудник из `rateEditors` — токеном установщика,
 * потому что app.option.set доступен только администратору (документация метода).
 */
export async function saveRatesFor(ctx: WriteContext, body: unknown): Promise<WriteResult> {
  // Список редакторов — из хранилища портала. Значение из тела запроса подделывается тривиально.
  const settings = parseSettings(await readOption(ctx.frameCall, SETTINGS_KEY))
  if (!canEditRates(settings, ctx.userId, ctx.isAdmin)) {
    return { status: 403, body: { error: 'rates write requires an administrator or a rate editor' } }
  }
  const entries = coerceRateEntries((body as { rates?: unknown } | null)?.rates)
  if (!entries) return { status: 400, body: { error: 'rates must be an array of objects' } }
  const issues = validateRates(entries)
  if (issues.length) return { status: 422, body: { error: 'invalid rates', issues } }
  // Круг «сериализация → разбор» отбрасывает посторонние поля записей.
  const value = serializeRates(parseRates(serializeRates(entries)))
  const writer = ctx.isAdmin ? ctx.frameCall : ctx.installerCall()
  const outcome = await writeOptionWithinBudget(ctx.frameCall, writer, RATES_KEY, value)
  return outcome.ok
    ? { status: 200, body: { ok: true, usage: outcome.usage, entries: entries.length } }
    : { status: 413, body: { error: 'storage budget exceeded', usage: outcome.usage } }
}
