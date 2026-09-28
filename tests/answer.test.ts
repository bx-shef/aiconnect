import { describe, expect, it } from 'vitest'
import { inlineSpans, parseAnswer } from '#shared/domain/answer'

const t = (text: string) => ({ text, bold: false, italic: false })
const b = (text: string) => ({ text, bold: true, italic: false })
const i = (text: string) => ({ text, bold: false, italic: true })

describe('inlineSpans — начертание в строке', () => {
  it('**жирный**, __жирный__, *курсив*, ***оба***', () => {
    expect(inlineSpans('**Срок** и __договор__, *курсив*, ***важно***')).toEqual([
      b('Срок'), t(' и '), b('договор'), t(', '), i('курсив'), t(', '), { text: 'важно', bold: true, italic: true }
    ])
  })

  it('арифметика — не курсив: звёздочка между буквами или цифрами остаётся', () => {
    expect(inlineSpans('ставка*2 и объём*3')).toEqual([t('ставка*2 и объём*3')])
    expect(inlineSpans('5*3 = 15, 2*4 = 8')).toEqual([t('5*3 = 15, 2*4 = 8')])
    expect(inlineSpans('2 * 3 = 6')).toEqual([t('2 * 3 = 6')])
    expect(inlineSpans('distance = a*b*c meters')).toEqual([t('distance = a*b*c meters')])
    expect(inlineSpans('E=mc*2, and F=m*a')).toEqual([t('E=mc*2, and F=m*a')])
  })

  it('с пробелами у звёздочек — не выделение (как markdown); разметка — только текст', () => {
    expect(inlineSpans('** и **')).toEqual([t('** и **')])
    expect(inlineSpans('<b>x</b> [URL=a]b[/URL]')).toEqual([t('<b>x</b> [URL=a]b[/URL]')])
  })
})

describe('parseAnswer — ответ на блоки', () => {
  it('заголовок, абзац, список с подпунктами, нумерованный список со своим номером', () => {
    expect(parseAnswer('## Риски\nЧто может вызвать вопросы:\n\n- **Срок** оплаты\n  - 7 дней\n* Нет договора\n\n3. Согласовать\n   - с бухгалтерией\n4) Добавить номер')).toEqual([
      { kind: 'h', spans: [t('Риски')] },
      { kind: 'p', lines: [[t('Что может вызвать вопросы:')]] },
      { kind: 'ul', items: [{ spans: [b('Срок'), t(' оплаты')], sub: [[t('7 дней')]] }, { spans: [t('Нет договора')], sub: [] }] },
      { kind: 'ol', start: 3, items: [{ spans: [t('Согласовать')], sub: [[t('с бухгалтерией')]] }, { spans: [t('Добавить номер')], sub: [] }] }
    ])
  })

  it('подпункты не сбивают нумерацию: 1-2-3, а не три списка с 1', () => {
    const blocks = parseAnswer('1. **Шаг**\n   - деталь\n2. Второй\n   - деталь\n3. Третий')
    expect(blocks).toHaveLength(1)
    expect(blocks[0]).toMatchObject({ kind: 'ol', start: 1 })
    expect(blocks[0]!.kind === 'ol' && blocks[0]!.items.map(x => x.sub.length)).toEqual([1, 1, 0])
  })

  it('семь решёток — не заголовок; маркер без пробела — не пункт («-5°C»); смена вида списка — два списка', () => {
    expect(parseAnswer('####### x')).toEqual([{ kind: 'p', lines: [[t('####### x')]] }])
    expect(parseAnswer('-5°C ночью')).toEqual([{ kind: 'p', lines: [[t('-5°C ночью')]] }])
    expect(parseAnswer('- a\n1. b').map(x => x.kind)).toEqual(['ul', 'ol'])
  })

  it('«Итоги по C#» — «#» на конце остаётся; закрывающие «##» через пробел убираются', () => {
    expect(parseAnswer('## Итоги по C#')).toEqual([{ kind: 'h', spans: [t('Итоги по C#')] }])
    expect(parseAnswer('### Итог ###')).toEqual([{ kind: 'h', spans: [t('Итог')] }])
  })

  it('пустая строка разделяет абзацы; текст после списка — новый абзац', () => {
    expect(parseAnswer('a\nb\n\nc\n- x\nd').map(x => x.kind)).toEqual(['p', 'p', 'ul', 'p'])
    expect(parseAnswer('a\nb')[0]).toEqual({ kind: 'p', lines: [[t('a')], [t('b')]] })
  })

  it('пусто и мусор — нет блоков', () => {
    expect(parseAnswer('')).toEqual([])
    expect(parseAnswer('\n\n  \n')).toEqual([])
    expect(parseAnswer(undefined as unknown as string)).toEqual([])
  })
})
