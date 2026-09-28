import { describe, expect, it } from 'vitest'
import { applyMarkup, cleanTag, normalizePercent, normalizeTag, resolveMarkup, type MarkupSettings } from '#shared/domain/markup'

// Решение по #3: на всё 70 %, тег «ЧЧ1» — 20 %, тег «ЧЧ2» — 120 %; порядок правил — приоритет.
const settings: MarkupSettings = {
  defaultPercent: 70,
  tags: [{ tag: 'ЧЧ1', percent: 20 }, { tag: 'ЧЧ2', percent: 120 }]
}

describe('resolveMarkup — первое совпадение по тегам задачи', () => {
  it('срабатывает правило, чей тег есть у задачи', () => {
    expect(resolveMarkup(settings, ['ЧЧ2'])).toEqual({ percent: 120, source: 'tag', tag: 'ЧЧ2' })
  })

  it('два подходящих тега — побеждает правило выше в списке, а не порядок тегов в задаче', () => {
    expect(resolveMarkup(settings, ['ЧЧ2', 'ЧЧ1'])).toEqual({ percent: 20, source: 'tag', tag: 'ЧЧ1' })
    const reversed: MarkupSettings = { ...settings, tags: [...settings.tags].reverse() }
    expect(resolveMarkup(reversed, ['ЧЧ1', 'ЧЧ2'])).toEqual({ percent: 120, source: 'tag', tag: 'ЧЧ2' })
  })

  it('регистр, пробелы и # не мешают совпадению', () => {
    expect(resolveMarkup(settings, ['  чч1 '])).toMatchObject({ percent: 20, source: 'tag' })
    expect(resolveMarkup({ ...settings, tags: [{ tag: '#Срочно', percent: 50 }] }, ['срочно'])).toMatchObject({ percent: 50 })
  })

  it('без тегов и без совпадений — наценка «на всё»', () => {
    expect(resolveMarkup(settings, [])).toEqual({ percent: 70, source: 'default' })
    expect(resolveMarkup(settings, ['другое'])).toEqual({ percent: 70, source: 'default' })
    // Тег — подстрока правила, а не совпадение.
    expect(resolveMarkup(settings, ['ЧЧ'])).toEqual({ percent: 70, source: 'default' })
  })

  it('правило с нулевой наценкой — тоже совпадение (не проваливается в «на всё»)', () => {
    expect(resolveMarkup({ defaultPercent: 70, tags: [{ tag: 'без наценки', percent: 0 }] }, ['Без наценки']))
      .toEqual({ percent: 0, source: 'tag', tag: 'без наценки' })
  })
})

describe('cleanTag', () => {
  it('убирает # и лишние пробелы, регистр сохраняет', () => {
    expect(cleanTag('  ##Важный   Клиент ')).toBe('Важный Клиент')
    expect(cleanTag(null)).toBe('')
  })
})

describe('normalizeTag', () => {
  it('убирает #, лишние пробелы и регистр; мусор — пустая строка', () => {
    expect(normalizeTag('  ##Важный   Клиент ')).toBe('важный клиент')
    expect(normalizeTag(42)).toBe('')
    expect(normalizeTag('#')).toBe('')
  })
})

describe('applyMarkup', () => {
  it('считает цену до копеек', () => {
    expect(applyMarkup(100, 70)).toBe(170)
    expect(applyMarkup(100, 120)).toBe(220)
    expect(applyMarkup(33.33, 20)).toBe(40)
    expect(applyMarkup(100, 0)).toBe(100)
  })

  it('округляет до копеек, а не до рублей (12,34 + 10 % = 13,57)', () => {
    expect(applyMarkup(12.34, 10)).toBe(13.57)
    expect(applyMarkup(0.01, 50)).toBe(0.02)
  })
})

describe('normalizePercent', () => {
  it('отвергает отрицательное и явные опечатки', () => {
    expect(normalizePercent('25,5')).toBe(25.5)
    expect(normalizePercent(-10)).toBeNull()
    expect(normalizePercent(10_001)).toBeNull()
  })
})

describe('applyMarkup — копейки как у портала (money.ts)', () => {
  it('половина копейки после наценки — вверх, даже когда двоичная дробь чуть меньше', () => {
    // 2,01 + 150% = 5,025 → 5,03. Прежнее Math.round(2,01 × 250) / 100 давало 5,02: 502,4999… в double.
    expect(Math.round(2.01 * 250) / 100).toBe(5.02)
    expect(applyMarkup(2.01, 150)).toBe(5.03)
    expect(applyMarkup(0.7, 65)).toBe(1.16)
    expect(applyMarkup(1.14, 75)).toBe(2)
  })
})
