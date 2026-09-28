import { describe, expect, it } from 'vitest'
import { applyNames, buildRows, clampName, MAX_ROW_NAME, toProductRows, type FillInput } from '#shared/domain/fill'
import { defaultSettings, type AppSettings } from '#shared/domain/settings'
import type { TaskInfo, TimeEntry } from '#shared/domain/tasks'
import { vatTotals } from '#shared/domain/vat'

function settings(patch: Partial<AppSettings> = {}): AppSettings {
  return { ...defaultSettings(), currency: 'RUB', ...patch }
}

const task: TaskInfo = {
  id: 10,
  title: 'Сверстать лендинг',
  description: 'Макет в Figma',
  responsibleId: 7,
  crmBindings: ['D_5'],
  timeSpentInLogs: 5400,
  tags: []
}

const entries: TimeEntry[] = [
  { id: 101, taskId: 10, userId: 7, seconds: 3600, comment: 'Вёрстка шапки', date: '2026-05-10' },
  { id: 102, taskId: 10, userId: 9, seconds: 1800, comment: 'Правки по макету', date: '2026-06-02' }
]

function input(patch: Partial<FillInput> = {}): FillInput {
  return {
    mode: 'task',
    tasks: [task],
    entries,
    rates: [
      { userId: 7, rate: 100, from: '2026-01-01' },
      { userId: 7, rate: 200, from: '2026-06-01' },
      // Версия из будущего: работы 2026 года по ней считаться не должны.
      { userId: 7, rate: 999, from: '2027-01-01' },
      { userId: 9, rate: 80, from: '2026-01-01' }
    ],
    settings: settings(),
    vatRate: null,
    ...patch
  }
}

describe('тип 1 — задача как строка', () => {
  it('всё время задачи × ставка ответственного на дату последней записи', () => {
    const { rows, errors } = buildRows(input())
    expect(errors).toEqual([])
    expect(rows).toHaveLength(1)
    // 1,5 ч всех участников, ставка ответственного #7 на 2026-06-02 — 200.
    expect(rows[0]).toMatchObject({ key: 't10', name: 'Сверстать лендинг', quantity: 1.5, baseRate: 200, rateDate: '2026-06-02', price: 200, sum: 300 })
  })

  it('округление применяется к сумме времени задачи', () => {
    const { rows } = buildRows(input({ settings: settings({ rounding: 60 }) }))
    expect(rows[0]?.quantity).toBe(2)
  })

  it('округление к ближайшему — по настройке направления', () => {
    // 1,5 ч к ближайшему часу — 2 ч (половина — вверх); 40 минут к ближайшим 30 — 30 минут.
    expect(buildRows(input({ settings: settings({ rounding: 60, roundingDirection: 'nearest' }) })).rows[0]?.quantity).toBe(2)
    const short = [{ ...entries[0]!, seconds: 2400 }]
    expect(buildRows(input({ entries: short, settings: settings({ rounding: 30, roundingDirection: 'nearest' }) })).rows[0]?.quantity).toBe(0.5)
  })

  it('время задачи, ставшее нулём после округления к ближайшему, — пропуск с предупреждением', () => {
    const tiny = [{ ...entries[1]!, userId: 7, seconds: 600 }]
    const { rows, errors, warnings } = buildRows(input({ entries: tiny, settings: settings({ rounding: 60, roundingDirection: 'nearest' }) }))
    expect(errors).toEqual([])
    expect(rows).toEqual([])
    expect(warnings).toEqual([{ taskId: 10, message: 'время 10 мин после округления стало нулём — строка пропущена' }])
  })

  it('ставка менялась за время задачи — строка по последней записи и предупреждение', () => {
    // Записи 10.05 (ставка 100 с 01.01) и 02.06 (ставка 200 с 01.06).
    const { rows, warnings } = buildRows(input({ userNames: new Map([[7, 'Иван Петров']]) }))
    expect(rows[0]?.baseRate).toBe(200)
    expect(warnings).toEqual([{
      taskId: 10,
      message: 'ставка Иван Петров менялась за время задачи: 100 с 01.01.2026 → 200 с 01.06.2026; применена 200 — на дату последней записи'
    }])
  })

  it('ставка не менялась — предупреждения нет', () => {
    const { warnings } = buildRows(input({ rates: [{ userId: 7, rate: 150, from: '2026-01-01' }] }))
    expect(warnings).toEqual([])
  })

  it('на ранние записи ставки не было — это тоже смена ставки', () => {
    const { rows, warnings } = buildRows(input({ rates: [{ userId: 7, rate: 200, from: '2026-06-01' }] }))
    expect(rows[0]?.baseRate).toBe(200)
    expect(warnings[0]?.message).toContain('нет ставки → 200 с 01.06.2026')
  })

  it('нулевые записи не участвуют в выборе даты ставки', () => {
    // Нулевая запись 01.07 не должна сдвинуть «последнюю запись» на 01.07.
    const withZero = [...entries, { ...entries[0]!, id: 103, seconds: 0, date: '2026-07-01' }]
    const { rows } = buildRows(input({ entries: withZero, rates: [...input().rates, { userId: 7, rate: 500, from: '2026-07-01' }] }))
    expect(rows[0]).toMatchObject({ rateDate: '2026-06-02', baseRate: 200 })
  })

  it('записи со временем, но без даты — ошибка: не на что выбрать ставку', () => {
    const { rows, errors } = buildRows(input({ entries: entries.map(e => ({ ...e, date: null })) }))
    expect(rows).toEqual([])
    expect(errors).toEqual([{ taskId: 10, message: 'у записей времени нет даты — не на что выбрать ставку' }])
  })

  it('нет ставки ответственного — ошибка, строки нет', () => {
    const { rows, errors } = buildRows(input({ rates: [{ userId: 9, rate: 80, from: '2026-01-01' }] }))
    expect(rows).toEqual([])
    expect(errors[0]?.message).toBe('нет ставки для #7 на 02.06.2026')
  })

  it('имя сотрудника в ошибке, если оно известно', () => {
    const { errors } = buildRows(input({ rates: [], userNames: new Map([[7, 'Иван Петров']]) }))
    expect(errors[0]?.message).toContain('Иван Петров')
  })

  it('задача без времени — ошибка «нет затраченного времени»', () => {
    const { errors } = buildRows(input({ entries: [], tasks: [{ ...task, timeSpentInLogs: 0 }] }))
    expect(errors).toEqual([{ taskId: 10, message: 'в задаче нет затраченного времени' }])
  })

  it('время в задаче есть, а записей не видно — говорим про доступ, а не «нет времени»', () => {
    const { errors } = buildRows(input({ entries: [] }))
    expect(errors[0]?.message).toContain('не прочитан')
  })

  it('наценка «на всё» идёт в цену', () => {
    const s = settings({ markup: { defaultPercent: 70, tags: [] } })
    const { rows } = buildRows(input({ settings: s }))
    expect(rows[0]).toMatchObject({ price: 340, markupPercent: 70, markupSource: 'default', sum: 510 })
    expect(rows[0]).not.toHaveProperty('markupTag')
  })

  it('наценка по тегу задачи сильнее «на всё»', () => {
    const s = settings({ markup: { defaultPercent: 70, tags: [{ tag: 'ЧЧ1', percent: 20 }] } })
    const { rows } = buildRows(input({ settings: s, tasks: [{ ...task, tags: ['чч1'] }], rates: [{ userId: 7, rate: 100, from: '2026-01-01' }] }))
    expect(rows[0]).toMatchObject({ price: 120, markupPercent: 20, markupSource: 'tag', markupTag: 'ЧЧ1' })
  })
})

describe('пересчёт в валюту счёта', () => {
  const conversion = { from: 'RUB', to: 'USD', factor: 1 / 80, notice: 'Цены пересчитаны — проверьте курс' }

  it('цена = ставка × курс × наценка, округление до центов один раз', () => {
    const s = settings({ markup: { defaultPercent: 70, tags: [] } })
    // 200 ₽ / 80 = 2,5 $ × 1,7 = 4,25 $.
    const { rows } = buildRows(input({ settings: s, conversion }))
    expect(rows[0]).toMatchObject({ baseRate: 200, price: 4.25, sum: 6.38 })
  })

  it('предупреждение о курсе — первым, одно на счёт', () => {
    const { warnings } = buildRows(input({ mode: 'time', conversion }))
    expect(warnings[0]).toEqual({ taskId: 0, message: conversion.notice })
    expect(warnings.filter(w => w.message === conversion.notice)).toHaveLength(1)
  })

  it('пересчёт и наценка по тегу вместе: курс, потом наценка тега', () => {
    const s = settings({ markup: { defaultPercent: 70, tags: [{ tag: 'ЧЧ1', percent: 20 }] } })
    // 200 ₽ / 80 = 2,5 $ × 1,2 = 3 $.
    const { rows } = buildRows(input({ settings: s, conversion, tasks: [{ ...task, tags: ['ЧЧ1'] }] }))
    expect(rows[0]).toMatchObject({ price: 3, markupSource: 'tag', markupTag: 'ЧЧ1', sum: 4.5 })
  })

  it('строк нет — и предупреждения о курсе нет', () => {
    const { warnings } = buildRows(input({ rates: [], conversion }))
    expect(warnings).toEqual([])
  })
})

describe('тип 2 — записи времени как строки', () => {
  it('строка на запись, ставка того, кто списал время, на дату записи', () => {
    const { rows, errors } = buildRows(input({ mode: 'time' }))
    expect(errors).toEqual([])
    expect(rows.map(r => [r.key, r.name, r.quantity, r.price, r.sum])).toEqual([
      ['e101', 'Вёрстка шапки', 1, 100, 100],
      ['e102', 'Правки по макету', 0.5, 80, 40]
    ])
    expect(vatTotals(rows)).toEqual({ net: 140, vat: 0, total: 140 })
  })

  it('запись без описания — ошибка: строку нечем назвать', () => {
    const { errors } = buildRows(input({ mode: 'time', entries: [{ ...entries[0]!, comment: '' }] }))
    expect(errors[0]).toMatchObject({ taskId: 10, entryId: 101 })
    expect(errors[0]?.message).toContain('нет описания')
  })

  it('наценка строки — по тегам ЕЁ задачи', () => {
    const s = settings({ markup: { defaultPercent: 0, tags: [{ tag: 'срочно', percent: 50 }] } })
    const { rows } = buildRows(input({ mode: 'time', settings: s, tasks: [{ ...task, tags: ['Срочно'] }] }))
    expect(rows.map(r => r.price)).toEqual([150, 120])
  })

  it('две задачи с разными тегами — у каждой строки наценка своей задачи, а не соседней', () => {
    const s = settings({ markup: { defaultPercent: 0, tags: [{ tag: 'срочно', percent: 50 }, { tag: 'дизайн', percent: 100 }] } })
    const second: TaskInfo = { ...task, id: 11, tags: ['Дизайн'] }
    const { rows } = buildRows(input({
      mode: 'time',
      settings: s,
      tasks: [{ ...task, tags: ['Срочно'] }, second],
      entries: [entries[0]!, { ...entries[0]!, id: 201, taskId: 11 }]
    }))
    expect(rows.map(r => [r.key, r.markupTag, r.price])).toEqual([['e101', 'срочно', 150], ['e201', 'дизайн', 200]])
  })

  it('запись, ставшая нулём при округлении к ближайшему, — пропуск с предупреждением', () => {
    const { rows, warnings } = buildRows(input({ mode: 'time', settings: settings({ rounding: 60, roundingDirection: 'nearest' }) }))
    // 60 мин → 1 ч, 30 мин → 1 ч (половина — вверх); обнуления нет.
    expect(rows.map(r => r.quantity)).toEqual([1, 1])
    const short = buildRows(input({ mode: 'time', entries: [{ ...entries[1]!, seconds: 1200 }], settings: settings({ rounding: 60, roundingDirection: 'nearest' }) }))
    expect(short.rows).toEqual([])
    expect(short.warnings).toEqual([{ taskId: 10, entryId: 102, message: 'время 20 мин после округления стало нулём — строка пропущена' }])
    expect(warnings).toEqual([])
  })

  it('нулевая запись пропускается с предупреждением, а не ошибкой', () => {
    const { rows, errors, warnings } = buildRows(input({ mode: 'time', entries: [...entries, { ...entries[0]!, id: 103, seconds: 0 }] }))
    expect(errors).toEqual([])
    expect(rows).toHaveLength(2)
    expect(warnings).toHaveLength(1)
  })

  it('ошибки собираются по всем записям сразу', () => {
    const { errors } = buildRows(input({ mode: 'time', rates: [] }))
    expect(errors).toHaveLength(2)
  })
})

describe('общие правила', () => {
  it('ни одной задачи — ошибка', () => {
    expect(buildRows(input({ tasks: [] })).errors[0]?.message).toBe('не найдено ни одной задачи')
  })

  it('длинное название обрезается до 255 символов', () => {
    const { rows } = buildRows(input({ tasks: [{ ...task, title: 'а'.repeat(400) }] }))
    expect(rows[0]?.name).toHaveLength(255)
  })

  it('clampName: ровно предел — без изменений, на символ больше — с многоточием', () => {
    expect(MAX_ROW_NAME).toBe(255)
    const exact = 'я'.repeat(MAX_ROW_NAME)
    expect(clampName(exact)).toBe(exact)
    const over = clampName(`${exact}ы`)
    expect(over).toHaveLength(MAX_ROW_NAME)
    expect(over.endsWith('…')).toBe(true)
    expect(clampName('  две\n строки\t ')).toBe('две строки')
  })
})

describe('applyNames — названия от BitrixGPT', () => {
  it('подставляет по ключу, а пропуск — ошибка, не тихий откат', () => {
    const { rows } = buildRows(input({ mode: 'time' }))
    const named = applyNames(rows, { e101: 'Вёрстка шапки сайта' })
    expect(named.rows[0]?.name).toBe('Вёрстка шапки сайта')
    expect(named.errors).toEqual([{ taskId: 10, entryId: 102, message: 'BitrixGPT не вернул название строки' }])
  })
})

describe('toProductRows — поля crm.item.productrow.*', () => {
  it('свободная позиция без товара каталога: название, цена, единица, сортировка после существующих', () => {
    const { rows } = buildRows(input({ rates: [{ userId: 7, rate: 100, from: '2026-01-01' }] }))
    expect(toProductRows(rows, settings({ measureCode: 356 }), 30)).toEqual([
      { productName: 'Сверстать лендинг', price: 100, quantity: 1.5, measureCode: 356, sort: 40 }
    ])
    expect(toProductRows(rows, settings())[0]).not.toHaveProperty('measureCode')
  })
})

describe('как строка ложится в счёт (priceMode)', () => {
  it('«цена часа» — цена часа и часы; сумма — их произведение', () => {
    const { rows } = buildRows(input())
    expect(rows[0]).toMatchObject({ hours: 1.5, hourPrice: 200, price: 200, quantity: 1.5, sum: 300 })
  })

  it('«сумма в цене» — цена = цена часа × часы, количество 1; часы и цена часа остаются для предпросмотра', () => {
    const built = buildRows(input({ settings: settings({ priceMode: 'sum' }) }))
    expect(built.rows[0]).toMatchObject({ hours: 1.5, hourPrice: 200, price: 300, quantity: 1, sum: 300 })
    // Режим сборки едет вместе со строками — подпись предпросмотра не зависит от перечитанных настроек.
    expect(built.priceMode).toBe('sum')
    expect(buildRows(input()).priceMode).toBe('hour')
    const time = buildRows(input({ mode: 'time', settings: settings({ priceMode: 'sum' }) })).rows
    expect(time.map(r => [r.key, r.price, r.quantity])).toEqual([['e101', 100, 1], ['e102', 40, 1]])
  })

  it('сумма в цене округляется до копеек как у портала: 10,19 × 5,5 = 56,05, а не 56,04', () => {
    // 10,19 × 5,5 в double — 56,044999…: Math.round(x * 100) дал бы 56,04 (roundMoney, vat.ts).
    const odd = buildRows(input({
      mode: 'time',
      entries: [{ ...entries[0]!, seconds: 5.5 * 3600 }],
      rates: [{ userId: 7, rate: 10.19, from: '2026-01-01' }],
      settings: settings({ priceMode: 'sum' })
    })).rows
    expect(odd[0]).toMatchObject({ hourPrice: 10.19, price: 56.05, quantity: 1, sum: 56.05 })
  })

  it('режим не меняет итог счёта', () => {
    const hour = vatTotals(buildRows(input({ mode: 'time', vatRate: 20 })).rows)
    const sum = vatTotals(buildRows(input({ mode: 'time', vatRate: 20, settings: settings({ priceMode: 'sum' }) })).rows)
    expect(sum).toEqual(hour)
    expect(hour).toEqual({ net: 140, vat: 28, total: 168 })
  })
})

describe('НДС в строках', () => {
  it('строки несут ставку счёта; цена в строке — без НДС', () => {
    const { rows } = buildRows(input({ vatRate: 20 }))
    expect(rows[0]).toMatchObject({ price: 200, taxRate: 20, sum: 300 })
    expect(buildRows(input()).rows[0]?.taxRate).toBeNull()
  })

  it('toProductRows: цена С налогом, ставка и «налог не включён» — портал сам выделит цену без НДС', () => {
    const { rows } = buildRows(input({ vatRate: 20, rates: [{ userId: 7, rate: 100.03, from: '2026-01-01' }] }))
    expect(toProductRows(rows, settings())).toEqual([
      { productName: 'Сверстать лендинг', price: 120.036, quantity: 1.5, taxRate: 20, taxIncluded: 'N', sort: 10 }
    ])
  })

  it('валюта счёта другая и НДС: сначала пересчёт и наценка (цена без НДС), налог — поверх пересчитанной цены', () => {
    const toUsd = { from: 'RUB', to: 'USD', factor: 1 / 80, notice: 'Цены пересчитаны — проверьте курс' }
    const { rows } = buildRows(input({ vatRate: 20, conversion: toUsd, settings: settings({ markup: { defaultPercent: 10, tags: [] } }) }))
    // 200 ₽ / 80 = 2,5 $; + 10% = 2,75 $ без НДС; в строку — 3,3 $ с налогом.
    expect(rows[0]).toMatchObject({ hourPrice: 2.75, price: 2.75, taxRate: 20 })
    expect(toProductRows(rows, settings())[0]).toMatchObject({ price: 3.3, quantity: 1.5, taxRate: 20 })
    // Налог 2,75 × 1,5 × 20% = 0,825 → 0,83, как портал на этой же строке (замер, tests/vat.test.ts).
    expect(vatTotals(rows)).toEqual({ net: 4.12, vat: 0.83, total: 4.95 })
  })

  it('0% — ставка пишется (это не «Без НДС»), цена как есть', () => {
    const { rows } = buildRows(input({ vatRate: 0 }))
    expect(toProductRows(rows, settings())[0]).toMatchObject({ price: 200, taxRate: 0, taxIncluded: 'N' })
  })

  it('«Без НДС» — налоговых полей в строке нет', () => {
    const payload = toProductRows(buildRows(input()).rows, settings())[0]!
    expect(payload).not.toHaveProperty('taxRate')
    expect(payload).not.toHaveProperty('taxIncluded')
  })

  it('«сумма в цене» с НДС: в строку — сумма с налогом и 1', () => {
    const { rows } = buildRows(input({ vatRate: 20, settings: settings({ priceMode: 'sum' }) }))
    expect(toProductRows(rows, settings())[0]).toMatchObject({ price: 360, quantity: 1, taxRate: 20 })
    expect(vatTotals(rows)).toEqual({ net: 300, vat: 60, total: 360 })
  })
})
