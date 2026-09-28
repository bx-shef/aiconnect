import { describe, expect, it } from 'vitest'
import {
  DEFAULT_TASK_TITLE_PROMPT,
  DEFAULT_TIME_BLOCK_PROMPT,
  MAX_CONSULT_CONTEXT,
  MAX_ITEM_TEXT,
  MAX_ITEM_TITLE,
  NAMING_FORMAT_RULES,
  buildConsultMessages,
  buildNamingMessages,
  clipNamingItem,
  effectiveNamingPrompt,
  fitConsultContext,
  pickNames
} from '#shared/domain/prompts'

describe('промпты названий', () => {
  it('пустой свой промпт — действует системный (так работает «восстановить системный»)', () => {
    expect(effectiveNamingPrompt('task', null)).toBe(DEFAULT_TASK_TITLE_PROMPT)
    expect(effectiveNamingPrompt('time', '   ')).toBe(DEFAULT_TIME_BLOCK_PROMPT)
    expect(effectiveNamingPrompt('time', 'Мой')).toBe('Мой')
  })

  it('правило формата ответа добавляется всегда, даже к своему промпту', () => {
    const [system] = buildNamingMessages('task', 'Мой промпт', [])
    expect(system?.content).toContain('Мой промпт')
    expect(system?.content).toContain(NAMING_FORMAT_RULES)
  })

  it('тип 1 передаёт заголовок, описание и отчёт; тип 2 — заголовок задачи и описание записи', () => {
    const t1 = JSON.parse(buildNamingMessages('task', null, [{ key: 't1', title: 'T', text: 'D', result: 'R' }])[1]!.content)
    expect(t1.items[0]).toEqual({ key: 't1', title: 'T', description: 'D', result: 'R' })
    const t2 = JSON.parse(buildNamingMessages('time', null, [{ key: 'e1', title: 'T', text: 'C' }])[1]!.content)
    expect(t2.items[0]).toEqual({ key: 'e1', taskTitle: 'T', text: 'C' })
  })
})

describe('pickNames — разбор ответа модели', () => {
  it('берёт только запрошенные ключи и только непустые строки', () => {
    expect(pickNames({ t1: ' Разработка ', t2: 42, extra: 'лишнее' }, ['t1', 't2'])).toEqual({ t1: 'Разработка' })
    expect(pickNames(['t1'], ['t1'])).toEqual({})
  })
})

describe('консультация', () => {
  it('обрезает слишком большой контекст', () => {
    const [, user] = buildConsultMessages('Оцени', { big: 'x'.repeat(MAX_CONSULT_CONTEXT * 2) })
    expect(user!.content.length).toBeLessThan(MAX_CONSULT_CONTEXT + 200)
    expect(user!.content).toContain('(обрезано)')
  })
})

describe('урезание до отправки', () => {
  it('clipNamingItem режет поля так же, как сервер, и не придумывает отчёт', () => {
    const item = clipNamingItem({ key: 't1', title: 'з'.repeat(600), text: 'о'.repeat(5000), result: 'р'.repeat(5000) })
    expect(item.title).toHaveLength(MAX_ITEM_TITLE + 1)
    expect(item.text).toHaveLength(MAX_ITEM_TEXT + 1)
    expect(item.result).toHaveLength(MAX_ITEM_TEXT + 1)
    expect(clipNamingItem({ key: 'e1', title: 'a', text: 'b' })).toEqual({ key: 'e1', title: 'a', text: 'b' })
  })

  it('clipNamingItem: ровно предел — без изменений, на символ больше — с многоточием', () => {
    const exact = clipNamingItem({ key: 't1', title: 'з'.repeat(MAX_ITEM_TITLE), text: 'о'.repeat(MAX_ITEM_TEXT) })
    expect(exact.title).toHaveLength(MAX_ITEM_TITLE)
    expect(exact.title.endsWith('…')).toBe(false)
    expect(exact.text).toHaveLength(MAX_ITEM_TEXT)
    const over = clipNamingItem({ key: 't1', title: 'з'.repeat(MAX_ITEM_TITLE + 1), text: 'о'.repeat(MAX_ITEM_TEXT + 1) })
    expect(over.title.endsWith('…')).toBe(true)
    expect(over.text.endsWith('…')).toBe(true)
  })

  it('fitConsultContext: влезает — без изменений и без пометки', () => {
    const ctx = { invoice: { title: 'Счёт' }, rows: [{ n: 1 }], tasks: [{ id: 1 }] }
    expect(fitConsultContext(ctx)).toEqual(ctx)
  })

  it('fitConsultContext: не влезает — целые элементы по порядку, пометка truncated, JSON в пределе', () => {
    const tasks = Array.from({ length: 200 }, (_, i) => ({ id: i, description: 'д'.repeat(900) }))
    const fitted = fitConsultContext({ invoice: { title: 'Счёт' }, rows: [{ n: 1 }], tasks })
    expect(fitted.truncated).toBe(true)
    expect(fitted.rows).toEqual([{ n: 1 }])
    expect(fitted.tasks.length).toBeGreaterThan(0)
    expect(fitted.tasks.length).toBeLessThan(200)
    expect(fitted.tasks[0]).toEqual(tasks[0])
    expect(JSON.stringify(fitted).length).toBeLessThanOrEqual(MAX_CONSULT_CONTEXT)
  })

  it('fitConsultContext: предел ровно по размеру — всё помещается', () => {
    const ctx = { invoice: {}, rows: [{ a: 1 }], tasks: [{ b: 2 }] }
    const exact = JSON.stringify({ ...ctx, truncated: true }).length
    expect(fitConsultContext(ctx, exact)).toEqual(ctx)
    expect(fitConsultContext(ctx, exact - 1).truncated).toBe(true)
  })
})
