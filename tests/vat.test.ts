import { describe, expect, it } from 'vitest'
import {
  grossPrice,
  netDrift,
  normalizeVatRate,
  parseMyCompanies,
  parseVatRates,
  vatForInvoice,
  vatLabel,
  vatTotals,
  type CompanyVat
} from '#shared/domain/vat'
import { roundMoney } from '#shared/domain/money'

describe('normalizeVatRate — ставка из хранилища или формы', () => {
  it('число от 0 до 100 до сотых; null — «Без НДС»', () => {
    expect(normalizeVatRate(20)).toBe(20)
    expect(normalizeVatRate('10')).toBe(10)
    expect(normalizeVatRate(0)).toBe(0)
    expect(normalizeVatRate(100)).toBe(100)
    expect(normalizeVatRate(16.667)).toBe(16.67)
    expect(normalizeVatRate(null)).toBeNull()
  })

  it('мусор — не ставка, а не молчаливые 0% или «Без НДС»', () => {
    for (const bad of [undefined, '', '  ', 'двадцать', -1, 100.01, Number.NaN, Number.POSITIVE_INFINITY, {}, [], true]) {
      expect(normalizeVatRate(bad)).toBeUndefined()
    }
  })
})

describe('vatLabel', () => {
  it('подписи для людей', () => {
    expect(vatLabel(null)).toBe('Без НДС')
    expect(vatLabel(20)).toBe('НДС 20%')
    expect(vatLabel(7.5)).toBe('НДС 7,5%')
    expect(vatLabel(0)).toBe('НДС 0%')
  })
})

describe('vatForInvoice — ставка по «Реквизитам вашей компании» счёта', () => {
  const companies: CompanyVat[] = [
    { companyId: 20, title: 'ООО Альфа', rate: 20 },
    { companyId: 22, title: '', rate: null }
  ]

  it('реквизиты есть в настройках — их ставка и название', () => {
    expect(vatForInvoice(companies, 20)).toEqual({ ok: true, rate: 20, company: 'ООО Альфа' })
  })

  it('«Без НДС» — тоже заданная ставка; без названия — #ID', () => {
    expect(vatForInvoice(companies, 22)).toEqual({ ok: true, rate: null, company: '#22' })
  })

  it('в счёте нет реквизитов — стоп, а не тихий «Без НДС»', () => {
    const res = vatForInvoice(companies, null)
    expect(res.ok).toBe(false)
    expect(!res.ok && res.problem).toBe('В счёте не выбраны «Реквизиты вашей компании» — выберите их в карточке счёта: по ним берётся ставка НДС')
  })

  it('реквизитов нет в настройках — стоп с подсказкой, где задать', () => {
    const res = vatForInvoice(companies, 99)
    expect(!res.ok && res.problem).toBe('Для «Реквизитов вашей компании» #99 в настройках приложения не задан НДС — администратор задаёт его в «Настройки → НДС»')
    expect(vatForInvoice([], 20).ok).toBe(false)
  })
})

describe('roundMoney — копейки как у портала', () => {
  it('половина копейки — вверх, даже когда двоичная дробь чуть меньше', () => {
    // 135,795 × 100 = 13579,4999… в double: Math.round(x * 100) дал бы 135,79.
    expect(roundMoney(135.795)).toBe(135.8)
    expect(roundMoney(1.005)).toBe(1.01)
    expect(roundMoney(678.975)).toBe(678.98)
    expect(roundMoney(1954.806)).toBe(1954.81)
    expect(roundMoney(2.2217778)).toBe(2.22)
    expect(roundMoney(0)).toBe(0)
    // Поправка на двоичную дробь не превращает настоящее «меньше половины» в половину.
    expect(roundMoney(0.004999999999)).toBe(0)
    expect(roundMoney(0.0049999)).toBe(0)
  })
})

describe('grossPrice — поле price строки (цена С налогом)', () => {
  it('цена без НДС × (1 + ставка), без округления до копеек', () => {
    expect(grossPrice(170, 20)).toBe(204)
    // Замер 2026-09-26: портал хранит 120,036 и выделяет цену без НДС ровно 100,03.
    expect(grossPrice(100.03, 20)).toBe(120.036)
    expect(grossPrice(123.45, 10)).toBe(135.795)
    expect(grossPrice(0.01, 20)).toBe(0.012)
    // Ставка с сотыми (16,67%) — все шесть знаков: 100,03 × 1,1667 = 116,705001; с четырьмя было бы
    // 116,705, и портал выделил бы цену без НДС 100,0299… вместо 100,03.
    expect(grossPrice(100.03, 16.67)).toBe(116.705001)
  })

  it('«Без НДС» и 0% — цена как есть', () => {
    expect(grossPrice(170, null)).toBe(170)
    expect(grossPrice(170, 0)).toBe(170)
  })
})

describe('vatTotals — итоги как у портала', () => {
  it('повтор замера 2026-09-26: девять строк → сумма счёта 1918,17 и НДС 263,04, как в портале', () => {
    // Тестовый портал, счёт #56: те же строки записаны `set` и `add`, портал вернул
    // opportunity 1918.17 и taxValue 263.04. НДС портал округляет по строкам, итог — один раз.
    const lines = [
      { price: 170, quantity: 1.5, taxRate: 20 },
      { price: 123.45, quantity: 5.5, taxRate: 20 },
      { price: 100.03, quantity: 1, taxRate: 20 },
      { price: 170, quantity: 1, taxRate: null },
      { price: 170, quantity: 1, taxRate: 0 },
      { price: 170, quantity: 1, taxRate: 20 },
      { price: 0.01, quantity: 3, taxRate: 20 },
      { price: 33.33, quantity: 0.3333, taxRate: 20 },
      { price: 50, quantity: 2, taxRate: 20 }
    ]
    expect(vatTotals(lines)).toEqual({ net: 1655.13, vat: 263.04, total: 1918.17 })
  })

  it('netDrift: строки без НДС (каждая до копеек) против «Без НДС» портала — те же 9 строк дают 2 копейки', () => {
    // Суммы строк предпросмотра: 255 + 678,98 + 100,03 + 170 × 3 + 0,03 + 11,11 + 100 = 1655,15.
    const sums = [255, 678.98, 100.03, 170, 170, 170, 0.03, 11.11, 100]
    expect(netDrift(sums, { net: 1655.13, vat: 263.04, total: 1918.17 })).toBe(0.02)
    expect(netDrift([140], { net: 140, vat: 28, total: 168 })).toBe(0)
  })

  it('граница половины копейки — как у портала (замер 2026-09-26, по одной строке в счёте #56)', () => {
    // [цена без НДС, часы, итог счёта, налог] — ответ портала на каждую строку при 20%.
    const measured: Array<[number, number, number, number]> = [
      [2.75, 1.5, 4.95, 0.83], [10.73, 2.5, 32.19, 5.37], [14.23, 2.5, 42.69, 7.12], [19.55, 1.5, 35.19, 5.87],
      [27.46, 1.25, 41.19, 6.87], [123.45, 5.5, 814.77, 135.8], [3.3, 0.5, 1.98, 0.33], [0.05, 0.1, 0.01, 0]
    ]
    for (const [price, quantity, total, vat] of measured) {
      expect(vatTotals([{ price, quantity, taxRate: 20 }])).toMatchObject({ total, vat })
    }
  })

  it('без НДС: налог 0, итог — одно округление суммы строк', () => {
    expect(vatTotals([{ price: 123.45, quantity: 5.5, taxRate: null }, { price: 0.005, quantity: 1, taxRate: null }]))
      .toEqual({ net: 678.98, vat: 0, total: 678.98 })
    expect(vatTotals([])).toEqual({ net: 0, vat: 0, total: 0 })
  })
})

describe('разбор ответов портала', () => {
  it('catalog.vat.list: только активные ставки; без числа — «Без НДС»', () => {
    expect(parseVatRates({ vats: [
      { id: 1, name: 'НДС 20%', rate: 20, active: 'Y' },
      { id: 2, name: 'НДС 10%', rate: '10', active: 'N' },
      { id: 3, name: 'Без НДС', rate: null, active: 'Y' },
      { id: 4, name: '', rate: 0, active: 'Y' },
      { id: 5, name: 'Битая', rate: 'x', active: 'Y' },
      null
    ] })).toEqual([
      { name: 'НДС 20%', rate: 20 },
      { name: 'Без НДС', rate: null },
      { name: 'НДС 0%', rate: 0 }
    ])
    expect(parseVatRates(undefined)).toEqual([])
    expect(parseVatRates({ vats: 'x' })).toEqual([])
  })

  it('crm.item.list моих компаний: id числом, название без пробелов, мусор отброшен', () => {
    expect(parseMyCompanies({ items: [{ id: '20', title: ' ООО Альфа ' }, { id: 0, title: 'x' }, { title: 'без id' }, null, { id: 22 }] }))
      .toEqual([{ id: 20, title: 'ООО Альфа' }, { id: 22, title: '' }])
    expect(parseMyCompanies(null)).toEqual([])
  })
})
