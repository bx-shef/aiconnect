import { describe, expect, it } from 'vitest'
import { MAX_MEASURE_TITLE, OKEI_NAMES, parseMeasures } from '~/utils/measures'

// Ответ catalog.measure.list с тестового портала (замер 2026-09-24): у системных единиц
// measureTitle и symbol — null, заполнены только международные обозначения.
const live = [
  { code: 6, id: 1, isDefault: 'N', measureTitle: null, symbol: null, symbolIntl: 'm', symbolLetterIntl: 'MTR' },
  { code: 796, id: 9, isDefault: 'Y', measureTitle: null, symbol: null, symbolIntl: 'pc. 1', symbolLetterIntl: 'PCE. NMB' }
]

const titles = (raw: unknown) => parseMeasures(raw).map(m => [m.code, m.title])

describe('parseMeasures', () => {
  it('без названия у портала — название из ОКЕИ по коду, подпись с кодом', () => {
    expect(parseMeasures(live)).toEqual([
      { code: 6, title: 'Метр', label: 'Метр (код 6)' },
      { code: 796, title: 'Штука', label: 'Штука (код 796)' }
    ])
  })

  it('своё название портала сильнее ОКЕИ; затем symbol', () => {
    expect(titles([{ code: 796, measureTitle: ' Шт. ' }, { code: 356, symbol: 'ч' }])).toEqual([[796, 'Шт.'], [356, 'ч']])
  })

  it('в ОДНОЙ записи: measureTitle сильнее symbol, symbolIntl сильнее symbolLetterIntl', () => {
    expect(titles([
      { code: 5000, measureTitle: 'Коробка', symbol: 'кор' },
      { code: 5001, symbolIntl: 'box', symbolLetterIntl: 'BX' }
    ])).toEqual([[5000, 'Коробка'], [5001, 'box']])
  })

  it('название из одних пробелов — как нет названия: дальше по цепочке', () => {
    expect(titles([{ code: 796, measureTitle: '   ', symbol: '' }])).toEqual([[796, 'Штука']])
  })

  it('кода нет в ОКЕИ — международное обозначение; без названия — подпись только «код N»', () => {
    expect(parseMeasures([{ code: 5000, symbolIntl: 'box' }, { code: 5001, symbolLetterIntl: 'BX' }, { code: 5002 }])).toEqual([
      { code: 5000, title: 'box', label: 'box (код 5000)' },
      { code: 5001, title: 'BX', label: 'BX (код 5001)' },
      { code: 5002, title: '', label: 'код 5002' }
    ])
  })

  it('код строкой — как в других ответах REST; мусор и не целые коды отбрасываются', () => {
    expect(titles([{ code: '796' }])).toEqual([[796, 'Штука']])
    expect(parseMeasures([{ code: 0 }, { code: '1.5' }, { code: -6 }, null, 'x', { measureTitle: 'Час' }])).toEqual([])
    expect(parseMeasures({ measures: [] })).toEqual([])
  })

  it('длинное название обрезается до предела', () => {
    const [m] = parseMeasures([{ code: 5000, measureTitle: 'я'.repeat(MAX_MEASURE_TITLE + 50) }])
    expect(m?.title).toHaveLength(MAX_MEASURE_TITLE)
  })

  it('в справочнике есть час — единица для строк по времени', () => {
    expect(OKEI_NAMES[356]).toBe('Час')
  })
})
