import { describe, expect, it } from 'vitest'
import { currencyConversion, needsConversion, parseCurrencies } from '#shared/domain/currency'

// Форма ответа crm.currency.list — из примера документации метода (числа строками).
const raw = [
  { CURRENCY: 'RUB', AMOUNT_CNT: '1', AMOUNT: '1.0000', BASE: 'Y', DATE_UPDATE: '2024-01-29T12:28:40+02:00' },
  { CURRENCY: 'USD', AMOUNT_CNT: '1', AMOUNT: '92.5000', BASE: 'N', DATE_UPDATE: '2026-09-20T15:19:50+03:00' },
  { CURRENCY: 'KZT', AMOUNT_CNT: '100', AMOUNT: '18.5000', BASE: 'N', DATE_UPDATE: null }
]

describe('parseCurrencies', () => {
  it('курс одной единицы — AMOUNT / AMOUNT_CNT; дата — только день', () => {
    expect(parseCurrencies(raw)).toEqual([
      { code: 'RUB', unitRate: 1, base: true, updated: '2024-01-29' },
      { code: 'USD', unitRate: 92.5, base: false, updated: '2026-09-20' },
      { code: 'KZT', unitRate: 0.185, base: false, updated: null }
    ])
  })

  it('базовая — только при BASE = Y; поля нет или другое значение — не базовая', () => {
    const [noBase, other] = parseCurrencies([
      { CURRENCY: 'EUR', AMOUNT_CNT: '1', AMOUNT: '100' },
      { CURRENCY: 'GBP', AMOUNT_CNT: '1', AMOUNT: '110', BASE: 'yes' }
    ])
    expect(noBase?.base).toBe(false)
    expect(other?.base).toBe(false)
  })

  it('валюта без курса, с нулём или мусором в коде отбрасывается', () => {
    expect(parseCurrencies([
      { CURRENCY: 'EUR', AMOUNT_CNT: '1', AMOUNT: '0' },
      { CURRENCY: 'BYN', AMOUNT_CNT: '0', AMOUNT: '30' },
      { CURRENCY: 'рубль', AMOUNT_CNT: '1', AMOUNT: '1' },
      { CURRENCY: 'GBP', AMOUNT_CNT: '1', AMOUNT: 'x' },
      null
    ])).toEqual([])
    expect(parseCurrencies({ CURRENCY: 'RUB' })).toEqual([])
  })
})

describe('currencyConversion', () => {
  const currencies = parseCurrencies(raw)

  it('валюты совпадают или код пустой — пересчёта нет', () => {
    expect(currencyConversion('RUB', 'RUB', currencies)).toEqual({ ok: true, conversion: null })
    // Счёт без валюты считается в валюте ставок, как до #3; ставки без валюты — не пересчитываем.
    expect(currencyConversion('RUB', '', currencies)).toEqual({ ok: true, conversion: null })
    expect(currencyConversion('', 'EUR', currencies)).toEqual({ ok: true, conversion: null })
  })

  it('needsConversion — только две непустые разные валюты', () => {
    expect(needsConversion('RUB', 'USD')).toBe(true)
    expect(needsConversion('RUB', 'RUB')).toBe(false)
    expect(needsConversion('RUB', '')).toBe(false)
    expect(needsConversion('', 'USD')).toBe(false)
  })

  it('рубли → доллары: множитель и предупреждение «проверьте курс» с датой курса', () => {
    const res = currencyConversion('RUB', 'USD', currencies)
    expect(res.ok).toBe(true)
    if (!res.ok || !res.conversion) throw new Error('ожидался пересчёт')
    expect(res.conversion.factor).toBeCloseTo(1 / 92.5, 12)
    expect(res.conversion.notice).toBe('Цены пересчитаны из RUB в USD по курсу портала: 1 USD = 92,5 RUB (курс обновлён: USD — 20.09.2026) — проверьте курс перед отправкой счёта')
  })

  it('кросс-курс через базовую валюту, дробный курс — до 4 знаков', () => {
    const res = currencyConversion('USD', 'KZT', currencies)
    if (!res.ok || !res.conversion) throw new Error('ожидался пересчёт')
    // 1 USD = 92,5 RUB, 1 KZT = 0,185 RUB → 1 USD = 500 KZT.
    expect(res.conversion.factor).toBeCloseTo(500, 9)
    expect(res.conversion.notice).toContain('1 KZT = 0,002 USD')
    expect(res.conversion.notice).toContain('(курс обновлён: USD — 20.09.2026)')
  })

  it('нет курса в портале — стоп с понятной причиной', () => {
    expect(currencyConversion('RUB', 'EUR', currencies)).toEqual({
      ok: false,
      problem: 'В справочнике валют портала нет курса EUR — пересчитать ставки из RUB в EUR нельзя'
    })
    expect(currencyConversion('GBP', 'EUR', currencies)).toMatchObject({ ok: false, problem: expect.stringContaining('GBP и EUR') })
  })
})
