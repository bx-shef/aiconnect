import { describe, expect, it } from 'vitest'
import { ACTIVITY_ORIGINATOR, answerToBBCode, buildConsultActivity, EMPTY_ANSWER, MAX_ACTIVITY_TEXT, MAX_ACTIVITY_TITLE, neutralizeMarkup } from '#shared/domain/activity'
import { parseExistingRows } from '#shared/domain/invoice'
import { tokenNeedsRefresh } from '~/utils/frameToken'

describe('дело с ответом консультации — конфигурируемое, одна запись в ленте', () => {
  const input = { invoiceId: 8, promptTitle: 'Риски', answer: 'Всё хорошо', responsibleId: 5 }

  it('параметры crm.activity.configurable.add: владелец — счёт, закрыто сразу, вид ответа ИИ', () => {
    expect(buildConsultActivity(input)).toEqual({
      ownerTypeId: 31,
      ownerId: 8,
      fields: { completed: true, originatorId: ACTIVITY_ORIGINATOR, responsibleId: 5 },
      layout: {
        icon: { code: 'ai-process' },
        header: { title: 'Консультация BitrixGPT: Риски' },
        body: {
          logo: { code: 'ai-copilot' },
          blocks: {
            answer: { type: 'largeText', properties: { value: 'Всё хорошо' } },
            disclaimer: { type: 'text', properties: { value: 'Ответ сформирован BitrixGPT и может быть неточным.', size: 'xs', color: 'base_60' } }
          }
        }
      }
    })
  })

  it('только поля и значения из документации LayoutDto: иначе портал отвергнет дело (FIELD_IS_REDUNDANT, ENUM_FIELD)', () => {
    const layout = buildConsultActivity(input).layout
    expect(Object.keys(layout).sort()).toEqual(['body', 'header', 'icon'])
    expect(Object.keys(layout.body).sort()).toEqual(['blocks', 'logo'])
    const blocks = Object.entries(layout.body.blocks)
    expect(blocks.length).toBeLessThanOrEqual(20)
    for (const [key, block] of blocks) {
      expect(key).toMatch(/^[\w-]+$/)
      expect(['text', 'largeText']).toContain(block.type)
      if (block.properties.size) expect(['xs', 'sm', 'md']).toContain(block.properties.size)
      if (block.properties.color) expect(['base_50', 'base_60', 'base_70', 'base_90']).toContain(block.properties.color)
    }
  })

  it('нет ответственного — поля нет (портал поставит сам)', () => {
    expect(buildConsultActivity({ ...input, responsibleId: 0 }).fields).not.toHaveProperty('responsibleId')
  })

  it('разметка из ответа модели не станет ни ссылкой, ни тегом в карточке', () => {
    expect(neutralizeMarkup('[URL=https://evil]жми[/URL]')).toBe('［URL=https://evil］жми［/URL］')
    expect(neutralizeMarkup('<img src=x onerror=alert(1)>')).toBe('＜img src=x onerror=alert(1)＞')
    const p = buildConsultActivity({ ...input, promptTitle: '[B]x[/B]', answer: '[URL=a]b[/URL] <b>c</b>' })
    const layout = p.layout
    // Свои теги [b]/[i] ставит только answerToBBCode; чужих скобок в записи нет.
    expect(String(layout.body.blocks.answer?.properties.value)).not.toMatch(/[<>]|\[(?!\/?[bi]\])|(?<!\[\/?[bi])\]/)
    expect(String(layout.header.title)).not.toMatch(/[[\]<>]/)
  })

  it('длинный ответ и заголовок обрезаются', () => {
    const p = buildConsultActivity({ ...input, promptTitle: 'т'.repeat(400), answer: 'x'.repeat(MAX_ACTIVITY_TEXT + 10) })
    const layout = p.layout
    expect(String(layout.body.blocks.answer?.properties.value)).toHaveLength(MAX_ACTIVITY_TEXT)
    expect(String(layout.header.title)).toHaveLength(MAX_ACTIVITY_TITLE)
  })
})

describe('answerToBBCode — ответ в BB-код блока largeText (разбор общий с окном)', () => {
  it('заголовки — [b], жирный/курсив — [b]/[i], ***оба*** — вложены правильно, списки строками', () => {
    expect(answerToBBCode('## Риски\r\n- **срок** оплаты\n* второй *пункт*\n  - подпункт\n\n2. ***шаг***'))
      .toBe('[b]Риски[/b]\n\n- [b]срок[/b] оплаты\n- второй [i]пункт[/i]\n   - подпункт\n\n2. [b][i]шаг[/i][/b]')
  })

  it('арифметика и «звёздочки» не становятся тегами — вложенность всегда правильная', () => {
    expect(answerToBBCode('ставка*2 и объём*3')).toBe('ставка*2 и объём*3')
    expect(answerToBBCode('2*3*4*5 = 120')).toBe('2*3*4*5 = 120')
    expect(answerToBBCode('**********')).toBe('**********')
  })

  it('BB и HTML из ответа обезврежены ДО своих тегов: [URL] модели не станет ссылкой', () => {
    expect(answerToBBCode('**[URL=https://evil]жми[/URL]**')).toBe('[b]［URL=https://evil］жми［/URL］[/b]')
    expect(answerToBBCode('<script>x</script>')).toBe('＜script＞x＜/script＞')
  })

  it('пустой ответ — пояснение: у largeText значение обязательно', () => {
    expect(answerToBBCode('')).toBe(EMPTY_ANSWER)
    expect(answerToBBCode('  \n ')).toBe(EMPTY_ANSWER)
    expect(answerToBBCode(undefined as unknown as string)).toBe(EMPTY_ANSWER)
  })

  it('предел — целыми блоками, теги не рвутся; не влез первый блок — текст без разметки', () => {
    const bb = answerToBBCode('**один** два\n\n**три** четыре', 20)
    expect(bb).toBe('[b]один[/b] два')
    expect(answerToBBCode('**' + 'x'.repeat(50) + '**', 10)).toBe('**xxxxxxxx')
  })
})

describe('существующие позиции счёта', () => {
  it('разбирает productRows и отбрасывает строки без id', () => {
    expect(parseExistingRows([{ id: 3, productName: 'Часы', price: '100', quantity: 2, sort: 20 }, { productName: 'без id' }]))
      .toEqual([{ id: 3, productName: 'Часы', price: 100, quantity: 2, sort: 20 }])
    expect(parseExistingRows(null)).toEqual([])
  })
})

describe('свежесть фрейм-токена перед запросом к серверу', () => {
  it('обновляем, если токена нет или жить ему меньше минуты', () => {
    const now = 1_000_000
    expect(tokenNeedsRefresh(false, now)).toBe(true)
    expect(tokenNeedsRefresh({ expires: (now + 30_000) / 1000 }, now)).toBe(true)
    expect(tokenNeedsRefresh({ expires: (now + 3_600_000) / 1000 }, now)).toBe(false)
  })
})
