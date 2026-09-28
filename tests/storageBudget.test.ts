import { describe, expect, it } from 'vitest'
import {
  budgetFor,
  DOCUMENTED_OPTION_LIMIT,
  formatUsage,
  optionLimit,
  parseMeasuredLimit,
  phpSerializedLength,
  PROBE_KEY,
  PROBE_LADDER,
  probeFiller,
  STORAGE_KEY,
  storageUsage,
  utf8Length
} from '#shared/domain/storageBudget'

describe('бюджет app.option', () => {
  it('без замера — предел из документации ядра минус 30 %', () => {
    const usage = storageUsage({})
    expect(usage.limit).toBe(DOCUMENTED_OPTION_LIMIT)
    expect(usage.measured).toBe(false)
    expect(usage.budget).toBe(Math.floor(DOCUMENTED_OPTION_LIMIT * 0.7))
  })

  it('с замером — бюджет от замеренного предела', () => {
    const usage = storageUsage({ [STORAGE_KEY]: JSON.stringify({ limit: 65_000, at: '2026-09-24' }) })
    expect(usage).toMatchObject({ limit: 65_000, measured: true, budget: budgetFor(65_000) })
  })

  it('мусорный или заниженный замер игнорируется', () => {
    expect(parseMeasuredLimit('{"limit":10}')).toBeNull()
    expect(parseMeasuredLimit('{"limit":"много"}')).toBeNull()
    expect(parseMeasuredLimit('не json')).toBeNull()
    expect(optionLimit({ [STORAGE_KEY]: '{"limit":1.5}' }).limit).toBe(DOCUMENTED_OPTION_LIMIT)
  })

  it('считает байты UTF-8, а не символы: кириллица — по 2 байта', () => {
    expect(utf8Length('abc')).toBe(3)
    expect(utf8Length('ставка')).toBe(12)
  })

  it('длина совпадает с настоящей PHP-сериализацией', () => {
    // PHP: serialize(['k' => 'vv']) === 'a:1:{s:1:"k";s:2:"vv";}' — 24 символа.
    expect(phpSerializedLength({ k: 'vv' })).toBe('a:1:{s:1:"k";s:2:"vv";}'.length)
    expect(phpSerializedLength({})).toBe('a:0:{}'.length)
  })

  it('переполнение видно до сохранения', () => {
    expect(storageUsage({ ift_rates_v1: 'x'.repeat(2000) }).fits).toBe(false)
    expect(storageUsage({ ift_rates_v1: '[]' }).fits).toBe(true)
  })

  it('граница: ровно бюджет — влезает, на байт больше — нет', () => {
    const budget = budgetFor(DOCUMENTED_OPTION_LIMIT)
    // Обёртка сериализации одного ключа `k`: a:1:{s:1:"k";s:N:"…";} — считаем её сами.
    const overhead = phpSerializedLength({ k: '' })
    const exact = 'x'.repeat(budget - overhead - (String(budget - overhead).length - 1))
    const usage = storageUsage({ k: exact })
    expect(usage.bytes).toBe(budget)
    expect(usage.fits).toBe(true)
    expect(usage.ratio).toBe(1)
    expect(storageUsage({ k: `${exact}x` }).fits).toBe(false)
  })

  it('оценивает, сколько ещё версий ставок влезет', () => {
    const usage = storageUsage({ a: '' })
    expect(usage.rateCapacityLeft).toBe(Math.floor((usage.budget - usage.bytes) / 30))
    expect(formatUsage(usage)).toBe('0,0 из 1,4 КБ')
  })
})

describe('заполнитель ступени замера', () => {
  it('доводит размер всех опций ровно до ступени', () => {
    const backup = { ift_settings_v1: '{"a":1}' }
    for (const target of PROBE_LADDER) {
      const value = probeFiller(backup, target)!
      const size = phpSerializedLength({ ...backup, [PROBE_KEY]: value })
      // Длина числа в `s:N:` меняется скачком, поэтому допускаем недобор в один байт.
      expect(target - size).toBeGreaterThanOrEqual(0)
      expect(target - size).toBeLessThanOrEqual(1)
    }
  })

  it('ступень меньше занятого — пропуск', () => {
    expect(probeFiller({ big: 'x'.repeat(3000) }, 1500)).toBeNull()
  })
})
