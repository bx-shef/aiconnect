// Настройки приложения (общие для портала). Хранятся в app.option под ключом SETTINGS_KEY
// одной JSON-строкой; ставки — отдельным ключом (rates.ts), потому что их пишут другие люди.
// Разбор защитный: хранилище — внешние данные, битое поле заменяется значением по умолчанию.
// Контракт полей — docs/SETTINGS.md.

import { isRoundingDirection, isRoundingStep, type RoundingDirection, type RoundingStep } from './time'
import { cleanTag, MAX_TAG_LENGTH, normalizePercent, normalizeTag, type MarkupSettings, type TagMarkupRule } from './markup'
import { MAX_COMPANY_TITLE, normalizeVatRate, type CompanyVat } from './vat'

/** Ключ общих настроек в app.option. Суффикс версии — на случай несовместимой смены формата. */
export const SETTINGS_KEY = 'ift_settings_v1'
/** Ключ ставок в app.option. */
export const RATES_KEY = 'ift_rates_v1'

/** Откуда брать название строки: как есть из задачи или через BitrixGPT. */
export type NamingMode = 'plain' | 'ai'

/**
 * Как строка ложится в счёт (решение владельца, 2026-09-26):
 * • `hour` — цена = цена часа, количество = часы;
 * • `sum` — цена = цена часа × часы, количество = 1.
 * Сумму строки в обоих случаях считает портал.
 */
export type PriceMode = 'hour' | 'sum'

/** Пользовательский промпт консультации: запускается из карточки счёта, ответ уходит в дело. */
export interface ConsultPrompt {
  id: string
  title: string
  text: string
}

export interface AppSettings {
  /** Шаг округления затраченного времени (минуты), 0 — как есть. */
  rounding: RoundingStep
  /** Направление округления: вверх (по умолчанию) или к ближайшему. */
  roundingDirection: RoundingDirection
  /**
   * Валюта ставок. Счёт в другой валюте пересчитывается по курсу портала с предупреждением
   * (currency.ts, docs/PROCESSING.md).
   */
  currency: string
  /** Кто кроме администраторов может менять ставки (ID сотрудников). */
  rateEditors: number[]
  markup: MarkupSettings
  /** Код единицы измерения строк (`measureCode`); `null` — не передаём, портал берёт свою. */
  measureCode: number | null
  priceMode: PriceMode
  /**
   * НДС по «Реквизитам вашей компании» (vat.ts): цена строки — без НДС, налог сверху. Счёт, чьих
   * реквизитов здесь нет, не заполняется.
   */
  vat: CompanyVat[]
  naming: NamingMode
  /**
   * Промпты названий. `null` — действует системный (prompts.ts); так «восстановить системный»
   * — это просто сброс в `null`, и улучшение системного промпта доходит до всех порталов.
   */
  prompts: {
    taskTitle: string | null
    timeBlock: string | null
  }
  consultPrompts: ConsultPrompt[]
}

/** Пределы полей — защита от мусора и от переполнения хранилища. */
export const LIMITS = {
  rateEditors: 50,
  markupRules: 200,
  prompt: 4000,
  consultPrompts: 20,
  consultTitle: 100,
  vatCompanies: 50
} as const

export function defaultSettings(): AppSettings {
  return {
    rounding: 0,
    roundingDirection: 'up',
    currency: '',
    rateEditors: [],
    markup: { defaultPercent: 0, tags: [] },
    measureCode: null,
    priceMode: 'hour',
    vat: [],
    naming: 'plain',
    prompts: { taskTitle: null, timeBlock: null },
    consultPrompts: []
  }
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function positiveInt(value: unknown): number | null {
  const n = Number(value)
  return Number.isInteger(n) && n > 0 ? n : null
}

function text(value: unknown, max: number): string {
  return typeof value === 'string' ? value.slice(0, max) : ''
}

function nullablePrompt(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed ? trimmed.slice(0, LIMITS.prompt) : null
}

/**
 * Правила наценки по тегам. Порядок сохраняется — это приоритет. Повтор тега (без учёта регистра)
 * отбрасывается: правило ниже по списку всё равно никогда бы не сработало.
 */
function parseTagRules(value: unknown): TagMarkupRule[] {
  if (!Array.isArray(value)) return []
  const out: TagMarkupRule[] = []
  const seen = new Set<string>()
  for (const item of value.slice(0, LIMITS.markupRules)) {
    const o = asObject(item)
    const tag = cleanTag(o.tag)
    const key = normalizeTag(tag)
    const percent = normalizePercent(o.percent)
    if (!key || tag.length > MAX_TAG_LENGTH || percent === null || seen.has(key)) continue
    seen.add(key)
    out.push({ tag, percent })
  }
  return out
}

/** НДС по компаниям: одна запись на компанию (повтор отбрасывается), ставка — только валидная. */
function parseCompanyVat(value: unknown): CompanyVat[] {
  if (!Array.isArray(value)) return []
  const out: CompanyVat[] = []
  const seen = new Set<number>()
  for (const item of value.slice(0, LIMITS.vatCompanies)) {
    const o = asObject(item)
    const companyId = positiveInt(o.companyId)
    const rate = normalizeVatRate(o.rate)
    if (companyId === null || rate === undefined || seen.has(companyId)) continue
    seen.add(companyId)
    out.push({ companyId, title: text(o.title, MAX_COMPANY_TITLE).trim(), rate })
  }
  return out
}

function parseConsultPrompts(value: unknown): ConsultPrompt[] {
  if (!Array.isArray(value)) return []
  const out: ConsultPrompt[] = []
  const ids = new Set<string>()
  for (const item of value.slice(0, LIMITS.consultPrompts)) {
    const o = asObject(item)
    const id = text(o.id, 40).replace(/[^\w-]/g, '')
    const title = text(o.title, LIMITS.consultTitle).trim()
    const body = text(o.text, LIMITS.prompt).trim()
    if (!id || !title || !body || ids.has(id)) continue
    ids.add(id)
    out.push({ id, title, text: body })
  }
  return out
}

/**
 * Разбор настроек из app.option. Никогда не бросает: строка JSON, объект или мусор — на
 * выходе всегда полный объект настроек. Неизвестные ключи отбрасываются (в том числе
 * `__proto__`: мы строим объект заново, а не копируем входной).
 */
export function parseSettings(raw: unknown): AppSettings {
  let data: unknown = raw
  if (typeof raw === 'string') {
    try {
      data = JSON.parse(raw)
    } catch {
      data = {}
    }
  }
  const o = asObject(data)
  const d = defaultSettings()
  const markup = asObject(o.markup)
  const prompts = asObject(o.prompts)
  // ⚠ Без обрезки до проверки: `text(…, 3)` превращал «RUBLES» в «RUB» и пропускал мусор как валюту.
  const currency = typeof o.currency === 'string' ? o.currency.trim().toUpperCase() : ''
  return {
    rounding: isRoundingStep(o.rounding) ? o.rounding : d.rounding,
    roundingDirection: isRoundingDirection(o.roundingDirection) ? o.roundingDirection : d.roundingDirection,
    currency: /^[A-Z]{3}$/.test(currency) ? currency : d.currency,
    rateEditors: Array.isArray(o.rateEditors)
      ? [...new Set(o.rateEditors.map(positiveInt).filter((v): v is number => v !== null))].slice(0, LIMITS.rateEditors)
      : d.rateEditors,
    markup: {
      defaultPercent: normalizePercent(markup.defaultPercent) ?? d.markup.defaultPercent,
      tags: parseTagRules(markup.tags)
    },
    measureCode: positiveInt(o.measureCode),
    priceMode: o.priceMode === 'sum' ? 'sum' : 'hour',
    vat: parseCompanyVat(o.vat),
    naming: o.naming === 'ai' ? 'ai' : 'plain',
    prompts: {
      taskTitle: nullablePrompt(prompts.taskTitle),
      timeBlock: nullablePrompt(prompts.timeBlock)
    },
    consultPrompts: parseConsultPrompts(o.consultPrompts)
  }
}

/** Сериализация: сначала разбор (нормализация), потом JSON — в хранилище не попадает ничего лишнего. */
export function serializeSettings(settings: AppSettings): string {
  return JSON.stringify(parseSettings(settings))
}

/** Может ли пользователь менять ставки: администратор портала или назначенный редактор. */
export function canEditRates(settings: AppSettings, userId: number, isAdmin: boolean): boolean {
  return isAdmin || settings.rateEditors.includes(userId)
}

/**
 * Готовы ли настройки к заполнению счетов: без валюты ставок сверить счёт не с чем, без НДС хотя бы
 * одних реквизитов ни один счёт не заполнится (vatForInvoice). Сохранять настройки это не мешает.
 */
export function settingsProblems(settings: AppSettings): string[] {
  const problems: string[] = []
  if (!settings.currency) problems.push('Не выбрана валюта ставок')
  if (!settings.vat.length) problems.push('Не задан НДС ни для одних «Реквизитов вашей компании»')
  return problems
}
