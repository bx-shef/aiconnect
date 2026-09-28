import { describe, expect, it } from 'vitest'
import type { CompanyVat } from '#shared/domain/vat'
import { applyVatChoice, refreshVatTitles, VAT_NONE, VAT_UNSET, vatOptions, vatRows, vatValueFor } from '~/utils/vatSettings'

const stored: CompanyVat[] = [
  { companyId: 20, title: 'ООО Альфа', rate: 20 },
  { companyId: 22, title: 'ИП Бета', rate: null }
]

describe('vatOptions — варианты ставки', () => {
  it('«Не задано», «Без НДС», ставки портала; повторы не дублируются', () => {
    expect(vatOptions([{ name: 'НДС 20%', rate: 20 }, { name: 'Без НДС', rate: null }, { name: 'НДС 20% (дубль)', rate: 20 }], [])).toEqual([
      { label: 'Не задано — счёт не заполнится', value: VAT_UNSET },
      { label: 'Без НДС', value: VAT_NONE },
      { label: 'НДС 20%', value: '20' }
    ])
  })

  it('«Без НДС» есть всегда — даже когда у портала единственная ставка (как на тестовом портале)', () => {
    const values = vatOptions([{ name: 'НДС 20%', rate: 20 }], []).map(o => o.value)
    expect(values).toContain(VAT_NONE)
    expect(vatOptions([], []).map(o => o.value)).toEqual([VAT_UNSET, VAT_NONE])
  })

  it('сохранённая ставка, которой больше нет в портале, остаётся в списке с пометкой', () => {
    const options = vatOptions([{ name: 'НДС 20%', rate: 20 }], [{ companyId: 20, title: 'А', rate: 10 }])
    expect(options.at(-1)).toEqual({ label: 'НДС 10% (нет в ставках портала)', value: '10' })
  })
})

describe('vatValueFor / applyVatChoice', () => {
  it('что выбрано: ставка строкой, «Без НДС», «не задано»', () => {
    expect(vatValueFor(stored, 20)).toBe('20')
    expect(vatValueFor(stored, 22)).toBe(VAT_NONE)
    expect(vatValueFor(stored, 99)).toBe(VAT_UNSET)
  })

  it('смена ставки — на месте, порядок записей не прыгает; название — из портала', () => {
    expect(applyVatChoice(stored, { id: 20, title: 'ООО Альфа+' }, '10')).toEqual([
      { companyId: 20, title: 'ООО Альфа+', rate: 10 },
      stored[1]
    ])
  })

  it('новая компания добавляется в конец; «Без НДС» — ставка null', () => {
    expect(applyVatChoice(stored, { id: 23, title: 'ООО Гамма' }, VAT_NONE).at(-1)).toEqual({ companyId: 23, title: 'ООО Гамма', rate: null })
  })

  it('«Не задано» убирает запись; мусорное значение ничего не меняет', () => {
    expect(applyVatChoice(stored, { id: 20, title: 'А' }, VAT_UNSET)).toEqual([stored[1]])
    expect(applyVatChoice(stored, { id: 20, title: 'А' }, 'двадцать')).toEqual(stored)
  })

  it('исходный список не мутируется', () => {
    const before = structuredClone(stored)
    applyVatChoice(stored, { id: 20, title: 'А' }, '10')
    applyVatChoice(stored, { id: 23, title: 'Г' }, '20')
    expect(stored).toEqual(before)
  })
})

describe('vatRows / refreshVatTitles', () => {
  it('сначала реквизиты портала, затем записи настроек, которых в портале уже нет', () => {
    expect(vatRows([{ id: 20, title: 'ООО Альфа' }, { id: 30, title: 'ООО Дельта' }], stored)).toEqual([
      { company: { id: 20, title: 'ООО Альфа' }, missing: false },
      { company: { id: 30, title: 'ООО Дельта' }, missing: false },
      { company: { id: 22, title: 'ИП Бета' }, missing: true }
    ])
  })

  it('переименованные в портале реквизиты получают новое название; прочие записи — те же объекты', () => {
    const fresh = refreshVatTitles(stored, [{ id: 20, title: 'ООО «Альфа»' }])
    expect(fresh[0]).toEqual({ companyId: 20, title: 'ООО «Альфа»', rate: 20 })
    expect(fresh[1]).toBe(stored[1])
    // Ничего не переименовано — те же объекты: вкладка по этому решает, трогать ли черновик.
    expect(refreshVatTitles(stored, [{ id: 20, title: 'ООО Альфа' }]).every((v, i) => v === stored[i])).toBe(true)
  })
})
