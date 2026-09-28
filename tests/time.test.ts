import { describe, expect, it } from 'vitest'
import { formatDuration, formatRuDate, isIsoDate, portalDate, roundSeconds, secondsToHours } from '#shared/domain/time'

describe('roundSeconds — округление затраченного времени', () => {
  it('«как есть» не трогает секунды', () => {
    expect(roundSeconds(1234, 0)).toBe(1234)
  })

  it.each([
    [60, 1, 3600], // 1 секунда — уже начатый час
    [60, 3600, 3600], // ровно час не округляется
    [60, 3601, 7200],
    [30, 1801, 3600],
    [10, 601, 1200],
    [5, 299, 300],
    [5, 301, 600]
  ] as const)('шаг %i мин: %i с → %i с', (step, input, expected) => {
    expect(roundSeconds(input, step)).toBe(expected)
  })

  it('ноль, отрицательное и мусор дают ноль — не «один шаг»', () => {
    expect(roundSeconds(0, 60)).toBe(0)
    expect(roundSeconds(-5, 60)).toBe(0)
    expect(roundSeconds(Number.NaN, 30)).toBe(0)
    expect(roundSeconds(0, 60, 'nearest')).toBe(0)
  })

  it.each([
    [60, 1, 0], // короче половины шага — ноль
    [60, 1799, 0],
    [60, 1800, 3600], // ровно половина — вверх
    [60, 5399, 3600],
    [30, 2700, 3600],
    [10, 899, 600],
    [5, 150, 300]
  ] as const)('к ближайшему, шаг %i мин: %i с → %i с', (step, input, expected) => {
    expect(roundSeconds(input, step, 'nearest')).toBe(expected)
  })

  it('по умолчанию — вверх; «как есть» не зависит от направления', () => {
    expect(roundSeconds(1, 60)).toBe(roundSeconds(1, 60, 'up'))
    expect(roundSeconds(1234, 0, 'nearest')).toBe(1234)
  })
})

describe('formatRuDate', () => {
  it('ГГГГ-ММ-ДД → ДД.ММ.ГГГГ; не дата — как есть', () => {
    expect(formatRuDate('2026-09-01')).toBe('01.09.2026')
    expect(formatRuDate('2026-02-31')).toBe('2026-02-31')
    expect(formatRuDate('')).toBe('')
  })
})

describe('secondsToHours', () => {
  it('переводит в часы с точностью до 4 знаков', () => {
    expect(secondsToHours(5400)).toBe(1.5)
    expect(secondsToHours(1234)).toBe(0.3428)
  })
})

describe('portalDate — дата записи в поясе портала', () => {
  it('берёт календарную дату как её видит портал, без перевода в UTC', () => {
    // 00:30 по Москве — это ещё 17-е по UTC; ставка должна выбираться на 18-е.
    expect(portalDate('2025-12-18T00:30:00+03:00')).toBe('2025-12-18')
  })

  it('отвергает мусор и несуществующие даты', () => {
    expect(portalDate('')).toBeNull()
    expect(portalDate(42)).toBeNull()
    expect(portalDate('2026-02-31T10:00:00+03:00')).toBeNull()
  })
})

describe('isIsoDate', () => {
  it('принимает только существующие дни в формате ГГГГ-ММ-ДД', () => {
    expect(isIsoDate('2024-02-29')).toBe(true)
    expect(isIsoDate('2025-02-29')).toBe(false)
    expect(isIsoDate('01.02.2025')).toBe(false)
  })
})

describe('formatDuration', () => {
  it('пишет часы и минуты по-русски', () => {
    expect(formatDuration(3900)).toBe('1 ч 05 мин')
    expect(formatDuration(600)).toBe('10 мин')
    expect(formatDuration(42)).toBe('42 с')
  })
})
