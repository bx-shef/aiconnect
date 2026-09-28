// Пересчёт ставок в валюту счёта по курсу портала (решение владельца по #3: «Б + предупреждение,
// что курс стоит проверить»). Курсы — из справочника валют CRM (crm.currency.list): курс валюты —
// цена `AMOUNT_CNT` её единиц в базовой валюте портала (`AMOUNT`). Правило — docs/PROCESSING.md.

import { formatRuDate } from './time'

/** Валюта справочника CRM — только то, что нужно для пересчёта и предупреждения. */
export interface PortalCurrency {
  code: string
  /** Цена ОДНОЙ единицы валюты в базовой валюте портала (`AMOUNT / AMOUNT_CNT`). */
  unitRate: number
  base: boolean
  /** Когда курс обновляли (`DATE_UPDATE`, `YYYY-MM-DD`); `null` — портал не сказал. */
  updated: string | null
}

/** Пересчёт цен из валюты ставок в валюту счёта. */
export interface CurrencyConversion {
  from: string
  to: string
  /** Множитель цены: цена в `to` = цена в `from` × `factor`. */
  factor: number
  /** Предупреждение для предпросмотра и итога записи: курс и призыв его проверить. */
  notice: string
}

/** Сколько знаков курса показываем человеку. */
const RATE_DIGITS = 4

function finitePositive(value: unknown): number | null {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? n : null
}

/**
 * Разбор ответа crm.currency.list (числа строками, как в документации метода). Валюта без
 * корректного курса отбрасывается: считать по нулю или мусору нельзя.
 */
export function parseCurrencies(raw: unknown): PortalCurrency[] {
  if (!Array.isArray(raw)) return []
  const out: PortalCurrency[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const o = item as Record<string, unknown>
    const code = typeof o.CURRENCY === 'string' ? o.CURRENCY.trim().toUpperCase() : ''
    const amount = finitePositive(o.AMOUNT)
    const count = finitePositive(o.AMOUNT_CNT)
    if (!/^[A-Z]{3}$/.test(code) || amount === null || count === null) continue
    const updated = typeof o.DATE_UPDATE === 'string' && /^\d{4}-\d{2}-\d{2}/.test(o.DATE_UPDATE) ? o.DATE_UPDATE.slice(0, 10) : null
    out.push({ code, unitRate: amount / count, base: o.BASE === 'Y', updated })
  }
  return out
}

/** Курс для человека: `92,5` / `0,0108` — без хвостовых нулей, с запятой. */
function formatRate(value: number): string {
  return String(Number(value.toFixed(RATE_DIGITS))).replace('.', ',')
}

/**
 * Нужен ли пересчёт: у счёта есть валюта, и она не совпадает с валютой ставок. Счёт без валюты
 * (портал её не отдал) считается в валюте ставок — как до #3.
 */
export function needsConversion(from: string, to: string): boolean {
  return !!from && !!to && from !== to
}

export type ConversionResult
  = | { ok: true, conversion: CurrencyConversion | null }
    | { ok: false, problem: string }

/**
 * Пересчёт из валюты ставок в валюту счёта. Валюты совпадают — пересчёта нет (`conversion: null`).
 * Курса одной из валют в портале нет — остановка: считать по неизвестному курсу нельзя.
 */
export function currencyConversion(from: string, to: string, currencies: readonly PortalCurrency[]): ConversionResult {
  if (!needsConversion(from, to)) return { ok: true, conversion: null }
  const src = currencies.find(c => c.code === from)
  const dst = currencies.find(c => c.code === to)
  const missing = [src ? null : from, dst ? null : to].filter(Boolean)
  if (!src || !dst) {
    return { ok: false, problem: `В справочнике валют портала нет курса ${missing.join(' и ')} — пересчитать ставки из ${from} в ${to} нельзя` }
  }
  const dates = [src, dst].filter(c => !c.base && c.updated).map(c => `${c.code} — ${formatRuDate(c.updated!)}`)
  const updated = dates.length ? ` (курс обновлён: ${dates.join(', ')})` : ''
  const notice = `Цены пересчитаны из ${from} в ${to} по курсу портала: 1 ${to} = ${formatRate(dst.unitRate / src.unitRate)} ${from}${updated} — проверьте курс перед отправкой счёта`
  return { ok: true, conversion: { from, to, factor: src.unitRate / dst.unitRate, notice } }
}
