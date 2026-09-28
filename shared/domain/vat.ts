// НДС в строках счёта. Решение владельца (#4, 2026-09-26): цена строки — БЕЗ НДС, налог
// начисляется сверху; ставка — из настроек приложения, своя для каждых «Реквизитов вашей
// компании» (поле счёта `mycompanyId`, в CRM — компании с `isMyCompany = Y`).
//
// Как это пишется в портал (документация crm.item.productrow.add + замер 2026-09-26 на тестовом
// портале, docs/REST_METHODS.md): поле `price` — цена С налогом, `priceExclusive` (без налога)
// только для чтения — портал выделяет её сам: price / (1 + ставка). Поэтому «цена без НДС» уходит
// как price = цена × (1 + ставка), taxRate = ставка, taxIncluded = N.

import { roundMoney } from './money'

/** Ставка НДС в процентах; `null` — «Без НДС» (налоговые поля в строку не пишутся). */
export type VatRate = number | null

/** Ставка НДС для «Реквизитов вашей компании» — одна запись настроек. */
export interface CompanyVat {
  /** ID компании CRM с признаком «моя компания» — то же, что `mycompanyId` счёта. */
  companyId: number
  /** Название на момент сохранения настроек — для сообщений на странице счёта. */
  title: string
  rate: VatRate
}

/** Предел названия компании в настройках — место в app.option не бесконечно. */
export const MAX_COMPANY_TITLE = 255

/**
 * Ставка из хранилища или из формы: число от 0 до 100, до сотых. Всё прочее — `undefined`
 * (не ставка), чтобы битое значение не превратилось молча в «Без НДС» или в 0%.
 */
export function normalizeVatRate(value: unknown): VatRate | undefined {
  if (value === null) return null
  if (typeof value !== 'number' && typeof value !== 'string') return undefined
  if (typeof value === 'string' && !value.trim()) return undefined
  const n = Number(value)
  if (!Number.isFinite(n) || n < 0 || n > 100) return undefined
  return Math.round(n * 100) / 100
}

/** Подпись ставки для людей: «НДС 20%», «Без НДС». */
export function vatLabel(rate: VatRate): string {
  return rate === null ? 'Без НДС' : `НДС ${String(rate).replace('.', ',')}%`
}

/**
 * Ставка счёта: `ok` — ставка (или «Без НДС») и название реквизитов для предпросмотра; иначе —
 * причина остановки для красного блока.
 */
export type VatChoice
  = | { ok: true, rate: VatRate, company: string }
    | { ok: false, problem: string }

/**
 * Ставка для счёта по его «Реквизитам вашей компании». Нет реквизитов в счёте или нет ставки для
 * них в настройках — остановка с понятной причиной (правило «чего-то не хватает — стоп»): тихий
 * «Без НДС» выставил бы клиенту счёт без налога.
 */
export function vatForInvoice(companies: readonly CompanyVat[], myCompanyId: number | null): VatChoice {
  if (myCompanyId === null) {
    return { ok: false, problem: 'В счёте не выбраны «Реквизиты вашей компании» — выберите их в карточке счёта: по ним берётся ставка НДС' }
  }
  const found = companies.find(c => c.companyId === myCompanyId)
  if (!found) {
    return { ok: false, problem: `Для «Реквизитов вашей компании» #${myCompanyId} в настройках приложения не задан НДС — администратор задаёт его в «Настройки → НДС»` }
  }
  return { ok: true, rate: found.rate, company: found.title || `#${found.companyId}` }
}

/**
 * Значение поля `price` строки: цена С налогом. Не округляется до копеек — портал хранит её как
 * есть и выделяет цену без НДС точно (замер: 120,036 → 100,03); округлённая 120,04 дала бы
 * 100,0333… и расхождение на копейку в сумме строки.
 */
export function grossPrice(net: number, rate: VatRate): number {
  if (rate === null || rate === 0) return net
  return Number((net * (100 + rate) / 100).toFixed(6))
}

export interface VatTotals {
  /** Сумма без НДС. */
  net: number
  /** Налог: по каждой строке до копеек, затем сумма — как `taxValue` счёта у портала. */
  vat: number
  /** Итог счёта — то, что портал запишет в сумму счёта (`opportunity`). */
  total: number
}

/**
 * Итоги как у портала (замер 2026-09-26: счёт из девяти строк с разными ставками, количествами и
 * копейками и восемь строк на границе половины копейки — сумма и налог совпали до копейки,
 * tests/vat.test.ts): итог — сумма «цена с НДС × количество» по всем строкам, округлённая один
 * раз; НДС — по строкам, каждая округлена до копеек; без НДС — разница.
 */
export function vatTotals(lines: ReadonlyArray<{ price: number, quantity: number, taxRate: VatRate }>): VatTotals {
  let gross = 0
  let vat = 0
  for (const line of lines) {
    const lineGross = grossPrice(line.price, line.taxRate) * line.quantity
    gross += lineGross
    // Налог строки — от цены без НДС: разность «с НДС − без НДС» в double теряет половину копейки
    // (2,75 × 1,5 при 20%: 0,82499… вместо 0,825), а портал на этой строке дал 0,83 (замер).
    if (line.taxRate !== null) vat += roundMoney(line.price * line.quantity * line.taxRate / 100)
  }
  const total = roundMoney(gross)
  const tax = roundMoney(vat)
  return { net: roundMoney(total - tax), vat: tax, total }
}

/**
 * На сколько сумма строк без НДС (каждая округлена до копеек) расходится с «Без НДС» портала
 * (итог минус налог по строкам). Копейки неизбежны: портал округляет налог по строкам, а итог —
 * одной суммой; предпросмотр показывает цифры портала и объясняет разницу, а не прячет её.
 */
export function netDrift(rowSums: readonly number[], totals: VatTotals): number {
  return roundMoney(rowSums.reduce((sum, v) => sum + v, 0) - totals.net)
}

/** Ставка НДС портала для выбора в настройках. */
export interface PortalVat {
  /** Название ставки в портале («НДС 20%»); пустое — подпись по ставке. */
  name: string
  rate: VatRate
}

/**
 * Разбор `catalog.vat.list` (`{ vats: [{ name, rate, active }] }`, замер 2026-09-26). Берём только
 * активные; ставка без числа — «Без НДС».
 */
export function parseVatRates(result: unknown): PortalVat[] {
  const list = (result && typeof result === 'object' && 'vats' in result) ? (result as { vats: unknown }).vats : result
  if (!Array.isArray(list)) return []
  const out: PortalVat[] = []
  for (const item of list) {
    if (!item || typeof item !== 'object' || !('rate' in item)) continue
    const o = item as Record<string, unknown>
    if (o.active === 'N' || o.active === false) continue
    const rate = o.rate === null || o.rate === '' ? null : normalizeVatRate(o.rate)
    if (rate === undefined) continue
    out.push({ name: typeof o.name === 'string' && o.name.trim() ? o.name.trim() : vatLabel(rate), rate })
  }
  return out
}

/** «Моя компания» CRM: `crm.item.list` с `entityTypeId = 4` и `isMyCompany = Y`. */
export interface MyCompany {
  /** ID компании CRM — то же, что `mycompanyId` счёта. */
  id: number
  /** Название как в портале, до {@link MAX_COMPANY_TITLE} символов; может быть пустым. */
  title: string
}

/** Разбор страницы `crm.item.list` (`{ items: [{ id, title }] }`). */
export function parseMyCompanies(result: unknown): MyCompany[] {
  const list = (result && typeof result === 'object' && 'items' in result) ? (result as { items: unknown }).items : result
  if (!Array.isArray(list)) return []
  return list.map((item) => {
    const o = (item ?? {}) as Record<string, unknown>
    return { id: Number(o.id), title: typeof o.title === 'string' ? o.title.trim().slice(0, MAX_COMPANY_TITLE) : '' }
  }).filter(c => Number.isInteger(c.id) && c.id > 0)
}
