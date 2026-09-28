// Дело «консультация» в счёте — конфигурируемое дело приложения (crm.activity.configurable.add).
//
// Почему не crm.activity.todo.add, как раньше: универсальное дело даёт в ленте ДВЕ записи —
// открытое дело и серую запись истории (пробы 1–4 на тестовом портале 2026-09-26: двойник есть
// при любом сроке и без crm.activity.update), и выглядит как обычное дело. Владелец: оставить одну.
// Конфигурируемое дело, закрытое сразу, — одна запись в истории, не попадает в «Мои дела»,
// счётчики и пинги, и может выглядеть как ответ ИИ ядра: иконка `ai-process`, логотип
// `ai-copilot` (те же коды у записей CoPilot ядра — разбор коробки crm 26.800.0, отчёт владельца
// 2026-09-26). Структура `layout` — документация «Структура конфигурируемого дела» (MCP).
//
// ⚠ Метод работает только в контексте приложения (OAuth): вебхук получает ERROR_WRONG_CONTEXT
// (документация). Поэтому дело создаёт только страница во фрейме, правами сотрудника — ему нужно
// право изменять счёт, как и для записи товаров.

import { parseAnswer, type AnswerBlock, type AnswerSpan } from './answer'

/** Предел текста ответа в деле — стена текста в ленте всё равно не читается. */
export const MAX_ACTIVITY_TEXT = 20_000
/** Текст записи, если модель ответила пустотой: у блока `largeText` значение обязательно. */
export const EMPTY_ANSWER = 'BitrixGPT вернул пустой ответ.'
/** Предел заголовка записи. */
export const MAX_ACTIVITY_TITLE = 255
/** Источник данных дела (`originatorId`) — по нему дела приложения находятся в списке дел счёта. */
export const ACTIVITY_ORIGINATOR = 'invoice-from-tasks'
/** Иконка на линии ленты и логотип — те же коды, что у записей ИИ ядра (`crm.timeline.icon.list`). */
export const AI_ICON = 'ai-process'
export const AI_LOGO = 'ai-copilot'

/**
 * Обезвреживает разметку во внешнем тексте: ответ модели (на который влияют описания задач —
 * их пишет любой сотрудник) мог бы вставить `[URL=…]` или `<img onerror=…>` в запись, которую
 * видят все, кто открывает счёт. Полноширинные скобки выглядят похоже, но не разбираются ни
 * BB-парсером, ни браузером.
 */
export function neutralizeMarkup(text: string): string {
  return String(text ?? '')
    .replace(/\[/g, '［').replace(/\]/g, '］')
    .replace(/</g, '＜').replace(/>/g, '＞')
}

/** BB-код куска: текст обезврежен, свои теги вложены правильно — [b][i]…[/i][/b]. */
function spanToBB(span: AnswerSpan): string {
  let text = neutralizeMarkup(span.text)
  if (span.italic) text = `[i]${text}[/i]`
  if (span.bold) text = `[b]${text}[/b]`
  return text
}

const lineToBB = (spans: AnswerSpan[]): string => spans.map(spanToBB).join('')

/** Блок ответа → строки BB-кода. Списки остаются строками «- пункт» / «1. пункт», как в ядре. */
function blockToBB(block: AnswerBlock): string {
  if (block.kind === 'h') return `[b]${block.spans.map(s => spanToBB({ ...s, bold: false })).join('')}[/b]`
  if (block.kind === 'p') return block.lines.map(lineToBB).join('\n')
  return block.items.map((item, n) => {
    const marker = block.kind === 'ol' ? `${block.start + n}.` : '-'
    return [`${marker} ${lineToBB(item.spans)}`, ...item.sub.map(sub => `   - ${lineToBB(sub)}`)].join('\n')
  }).join('\n')
}

/**
 * Ответ модели (markdown) → BB-код для блока `largeText`: он разбирает BB (жирный, курсив) и
 * сворачивает длинный текст. Разбор — общий с окном приложения (answer.ts). Текст каждого куска
 * обезврежен ДО своих тегов: `[URL]` из ответа не станет ссылкой. Не больше `max` символов —
 * целыми блоками, чтобы обрезка не разорвала тег; не влез ни один блок — начало текста без разметки.
 * Пустой ответ — пояснение: у блока `largeText` значение обязательно.
 */
export function answerToBBCode(markdown: string, max = MAX_ACTIVITY_TEXT): string {
  // Разбор ограничен: ответ длиннее двух пределов всё равно не поместится.
  const source = Array.from(String(markdown ?? '')).slice(0, max * 2).join('')
  const parts: string[] = []
  let length = 0
  for (const block of parseAnswer(source)) {
    const bb = blockToBB(block)
    const add = (parts.length ? 2 : 0) + bb.length
    if (length + add > max) break
    parts.push(bb)
    length += add
  }
  if (parts.length) return parts.join('\n\n')
  const plain = Array.from(neutralizeMarkup(source.trim())).slice(0, max).join('')
  return plain || EMPTY_ANSWER
}

/** Контентный блок записи (документация: ContentBlockDto) — те типы, что использует приложение. */
export interface LayoutBlock {
  type: 'text' | 'largeText'
  properties: { value: string, size?: 'xs' | 'sm' | 'md', color?: 'base_50' | 'base_60' | 'base_70' | 'base_90' }
}

/** Параметры crm.activity.configurable.add (документация: LayoutDto без footer — действий нет). */
export interface ConsultActivityParams {
  ownerTypeId: number
  ownerId: number
  fields: { completed: true, originatorId: string, responsibleId?: number }
  layout: {
    icon: { code: string }
    header: { title: string }
    body: { logo: { code: string }, blocks: Record<string, LayoutBlock> }
  }
}

export interface ConsultActivityInput {
  invoiceId: number
  promptTitle: string
  answer: string
  responsibleId: number
}

/**
 * Параметры crm.activity.configurable.add для ответа консультации. Чистая функция.
 *
 * Дело закрыто сразу (`completed`): это запись о сделанном, а не задача — поэтому одна запись в
 * истории, без «Моих дел», счётчиков и пингов. Блоки — только из списка документации: `largeText`
 * (ответ, сворачивается), `text` (оговорка про ИИ; размеры `xs/sm/md`, цвета `base_50…90`).
 */
export function buildConsultActivity(input: ConsultActivityInput): ConsultActivityParams {
  return {
    ownerTypeId: 31,
    ownerId: input.invoiceId,
    fields: {
      completed: true,
      originatorId: ACTIVITY_ORIGINATOR,
      ...(input.responsibleId > 0 ? { responsibleId: input.responsibleId } : {})
    },
    layout: {
      icon: { code: AI_ICON },
      header: { title: neutralizeMarkup(`Консультация BitrixGPT: ${input.promptTitle}`).slice(0, MAX_ACTIVITY_TITLE) },
      body: {
        logo: { code: AI_LOGO },
        blocks: {
          answer: { type: 'largeText', properties: { value: answerToBBCode(input.answer) } },
          disclaimer: { type: 'text', properties: { value: 'Ответ сформирован BitrixGPT и может быть неточным.', size: 'xs', color: 'base_60' } }
        }
      }
    }
  }
}
