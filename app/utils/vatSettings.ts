// Вкладка «НДС» настроек: выбор ставки для каждых «Реквизитов вашей компании». Чистые функции —
// компонент (components/settings/SettingsVat.vue) только рисует. Правила НДС — shared/domain/vat.ts.

import { vatLabel, type CompanyVat, type MyCompany, type PortalVat, type VatRate } from '#shared/domain/vat'

/** Значение списка: ставка строкой, «Без НДС» или «не задано». Списки портала не любят `null`. */
export const VAT_UNSET = 'unset'
export const VAT_NONE = 'none'

export interface VatOption {
  label: string
  value: string
}

function valueOf(rate: VatRate): string {
  return rate === null ? VAT_NONE : String(rate)
}

/**
 * Варианты ставки: «Не задано», «Без НДС», ставки портала (`catalog.vat.list`) и уже сохранённые
 * ставки, которых в портале больше нет, — иначе список молча показал бы «Не задано» для
 * реквизитов, у которых ставка есть.
 */
export function vatOptions(portal: readonly PortalVat[], stored: readonly CompanyVat[]): VatOption[] {
  const out: VatOption[] = [{ label: 'Не задано — счёт не заполнится', value: VAT_UNSET }]
  const seen = new Set<string>([VAT_UNSET])
  const add = (value: string, label: string) => {
    if (seen.has(value)) return
    seen.add(value)
    out.push({ label, value })
  }
  add(VAT_NONE, vatLabel(null))
  for (const v of portal) add(valueOf(v.rate), v.rate === null ? vatLabel(null) : v.name)
  for (const s of stored) add(valueOf(s.rate), `${vatLabel(s.rate)} (нет в ставках портала)`)
  return out
}

/** Что выбрано для компании. */
export function vatValueFor(stored: readonly CompanyVat[], companyId: number): string {
  const found = stored.find(s => s.companyId === companyId)
  return found ? valueOf(found.rate) : VAT_UNSET
}

/**
 * Новый список НДС после выбора. Запись компании меняется на месте (порядок не прыгает), «Не
 * задано» её убирает; название обновляется — по нему страница счёта называет реквизиты.
 */
export function applyVatChoice(stored: readonly CompanyVat[], company: MyCompany, value: string): CompanyVat[] {
  if (value === VAT_UNSET) return stored.filter(s => s.companyId !== company.id)
  const rate: VatRate = value === VAT_NONE ? null : Number(value)
  if (rate !== null && !Number.isFinite(rate)) return [...stored]
  const next: CompanyVat = { companyId: company.id, title: company.title, rate }
  const index = stored.findIndex(s => s.companyId === company.id)
  if (index < 0) return [...stored, next]
  return stored.map((s, i) => (i === index ? next : s))
}

export interface VatRow {
  company: MyCompany
  /** Реквизитов нет среди «моих компаний» портала (удалены или сняли признак) — запись можно убрать. */
  missing: boolean
}

/**
 * Строки вкладки: «мои компании» портала, затем записи настроек, которых в портале уже нет.
 * Названия сохранённых записей освежаются из портала.
 */
export function vatRows(companies: readonly MyCompany[], stored: readonly CompanyVat[]): VatRow[] {
  const known = new Set(companies.map(c => c.id))
  return [
    ...companies.map(company => ({ company, missing: false })),
    ...stored.filter(s => !known.has(s.companyId)).map(s => ({ company: { id: s.companyId, title: s.title }, missing: true }))
  ]
}

/** Названия сохранённых записей — как в портале сейчас (компанию могли переименовать). */
export function refreshVatTitles(stored: readonly CompanyVat[], companies: readonly MyCompany[]): CompanyVat[] {
  const titles = new Map(companies.map(c => [c.id, c.title]))
  return stored.map(s => (titles.has(s.companyId) && titles.get(s.companyId) !== s.title ? { ...s, title: titles.get(s.companyId)! } : s))
}
