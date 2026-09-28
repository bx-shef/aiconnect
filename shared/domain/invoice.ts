// Счёт (новый, entityTypeId = 31): разбор ответа crm.item.get и проверки перед заполнением.

import type { AppSettings } from './settings'
import type { TaskSource } from './fill'
import { vatForInvoice, type VatChoice } from './vat'

export interface InvoiceInfo {
  id: number
  title: string
  currencyId: string
  /** Сделка, из которой выставлен счёт (`parentId2`); `null` — счёт без сделки. */
  dealId: number | null
  /** «Реквизиты вашей компании» (`mycompanyId`, 0 — не выбраны) — по ним ставка НДС (vat.ts). */
  myCompanyId: number | null
  opportunity: number
}

/** Разбор `crm.item.get` (`{ item: {...} }`). `null` — ответа нет или в нём нет id. */
export function parseInvoice(result: unknown): InvoiceInfo | null {
  const item = (result && typeof result === 'object' && 'item' in result)
    ? (result as { item: unknown }).item
    : result
  if (!item || typeof item !== 'object') return null
  const o = item as Record<string, unknown>
  const id = Number(o.id)
  if (!Number.isInteger(id) || id <= 0) return null
  const dealId = Number(o.parentId2)
  const myCompanyId = Number(o.mycompanyId)
  return {
    id,
    title: typeof o.title === 'string' ? o.title : '',
    currencyId: typeof o.currencyId === 'string' ? o.currencyId.toUpperCase() : '',
    dealId: Number.isInteger(dealId) && dealId > 0 ? dealId : null,
    myCompanyId: Number.isInteger(myCompanyId) && myCompanyId > 0 ? myCompanyId : null,
    opportunity: Number(o.opportunity) || 0
  }
}

/**
 * Что мешает заполнить счёт ещё до чтения задач (пусто — можно продолжать) и ставка НДС счёта —
 * одним разбором, чтобы остановка и ставка не разошлись.
 *
 * Валюта счёта, отличная от валюты ставок, — НЕ помеха (#3): цены пересчитываются по курсу
 * портала (currency.ts), а если курса нет — остановка там же. Нет «Реквизитов вашей компании» или
 * ставки НДС для них — помеха (vat.ts): без неё не посчитать налог.
 */
export function checkInvoice(invoice: InvoiceInfo, settings: AppSettings, source: TaskSource): { problems: string[], vat: VatChoice } {
  const problems: string[] = []
  if (!settings.currency) problems.push('В настройках приложения не выбрана валюта ставок')
  if (source === 'deal' && invoice.dealId === null) {
    problems.push('Счёт не связан со сделкой — выберите задачи, привязанные к самому счёту')
  }
  const vat = vatForInvoice(settings.vat, invoice.myCompanyId)
  if (!vat.ok) problems.push(vat.problem)
  return { problems, vat }
}

/** Только причины остановки — {@link checkInvoice} без выбранной ставки. */
export function invoiceProblems(invoice: InvoiceInfo, settings: AppSettings, source: TaskSource): string[] {
  return checkInvoice(invoice, settings, source).problems
}

/**
 * Изменился ли счёт между сбором строк и записью так, что строки к нему больше не подходят:
 * «Реквизиты вашей компании» (ставка НДС), валюта (пересчёт цен) или сделка (источник задач).
 * Счёт в карточке открыт рядом с окном приложения — его могли поменять, пока смотрели предпросмотр.
 * `null` — можно писать.
 */
export function invoiceChangedSince(collected: InvoiceInfo, now: InvoiceInfo): string | null {
  const changed: string[] = []
  if (collected.myCompanyId !== now.myCompanyId) changed.push('«Реквизиты вашей компании»')
  if (collected.currencyId !== now.currencyId) changed.push('валюта')
  if (collected.dealId !== now.dealId) changed.push('сделка')
  return changed.length ? `После сбора строк в счёте изменились: ${changed.join(', ')} — соберите строки заново` : null
}

/** Существующая позиция счёта — нужна для режима «добавить» (сортировка) и контекста консультации. */
export interface ExistingRow {
  id: number
  productName: string
  price: number
  quantity: number
  sort: number
}

/** Разбор существующих позиций счёта (`crm.item.productrow.list` → `productRows`). */
export function parseExistingRows(raw: unknown): ExistingRow[] {
  if (!Array.isArray(raw)) return []
  return raw.map((r) => {
    const o = (r ?? {}) as Record<string, unknown>
    return {
      id: Number(o.id) || 0,
      productName: typeof o.productName === 'string' ? o.productName : '',
      price: Number(o.price) || 0,
      quantity: Number(o.quantity) || 0,
      sort: Number(o.sort) || 0
    }
  }).filter(r => r.id > 0)
}
