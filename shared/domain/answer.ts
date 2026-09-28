// Разбор ответа BitrixGPT (markdown модели) — ОДИН на запись в ленте (BB-код, activity.ts) и окно
// приложения (components/invoice/ConsultAnswer.vue): иначе лента и окно показывали бы один ответ
// по-разному. Разбираем только то, что модель пишет в консультациях: абзацы, заголовки `#`, списки
// «- пункт» и «1. пункт» с подпунктами, `**жирный**`, `__жирный__`, `*курсив*`, `***оба***`.
// Всё прочее — обычный текст: в окне Vue его экранирует, в ленту он уходит обезвреженным.

/** Кусок строки с начертанием. */
export interface AnswerSpan {
  text: string
  bold: boolean
  italic: boolean
}

/** Пункт списка и его подпункты (строки с отступом под ним). */
export interface AnswerItem {
  spans: AnswerSpan[]
  sub: AnswerSpan[][]
}

/** Блок ответа: заголовок, абзац (строки через перенос) или список. */
export type AnswerBlock
  = | { kind: 'h', spans: AnswerSpan[] }
    | { kind: 'p', lines: AnswerSpan[][] }
    | { kind: 'ul', items: AnswerItem[] }
    | { kind: 'ol', start: number, items: AnswerItem[] }

// Закрывающие `#` — только через пробел (CommonMark): «Итоги по C#» не теряет «#».
const HEADING = /^[ \t]{0,3}#{1,6}[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/
const BULLET = /^([ \t]*)[-*+][ \t]+(.*)$/
const NUMBERED = /^([ \t]*)(\d{1,9})[.)][ \t]+(.*)$/
/** Отступ, с которого пункт — подпункт предыдущего. */
const SUB_INDENT = 2

// Выделение — только на границе слова (буквы любых алфавитов): «ставка*2 и объём*3» и «5*3» —
// арифметика, а не курсив. Сначала `***`, потом `**`/`__`, потом `*`: иначе теги вложились бы
// крест-накрест («[b][i]x[/b][/i]»).
const L = '\\p{L}\\p{N}'
const INLINE = new RegExp(
  `(?<![${L}*])\\*\\*\\*(?![\\s*])(.+?)(?<![\\s*])\\*\\*\\*(?![${L}*])`
  + `|(?<![${L}*])\\*\\*(?![\\s*])(.+?)(?<![\\s*])\\*\\*(?![${L}*])`
  + `|(?<![${L}_])__(?![\\s_])(.+?)(?<![\\s_])__(?![${L}_])`
  + `|(?<![${L}*])\\*(?![\\s*])([^*\\n]+?)(?<![\\s*])\\*(?![${L}*])`,
  'gu'
)

/** Строка → куски с начертанием. Пустые куски отбрасываются. */
export function inlineSpans(line: string): AnswerSpan[] {
  const out: AnswerSpan[] = []
  let last = 0
  for (const m of line.matchAll(INLINE)) {
    const at = m.index ?? 0
    if (at > last) out.push({ text: line.slice(last, at), bold: false, italic: false })
    if (m[1] !== undefined) out.push({ text: m[1], bold: true, italic: true })
    else if (m[2] !== undefined || m[3] !== undefined) out.push({ text: (m[2] ?? m[3])!, bold: true, italic: false })
    else out.push({ text: m[4]!, bold: false, italic: true })
    last = at + m[0].length
  }
  if (last < line.length) out.push({ text: line.slice(last), bold: false, italic: false })
  return out.filter(s => s.text)
}

function indentOf(ws: string): number {
  return ws.replace(/\t/g, '    ').length
}

/**
 * Ответ → блоки. Пустая строка разделяет абзацы; подряд идущие пункты — один список; пункт с
 * отступом под пунктом — его подпункт (нумерация внешнего списка не сбивается); номер первого
 * пункта сохраняется (`start`).
 */
export function parseAnswer(text: string): AnswerBlock[] {
  const out: AnswerBlock[] = []
  let paragraphOpen = false
  for (const raw of String(text ?? '').replace(/\r\n?/g, '\n').split('\n')) {
    const line = raw.trimEnd()
    const last = out.at(-1)
    const bullet = line.match(BULLET)
    const numbered = bullet ? null : line.match(NUMBERED)
    const heading = bullet || numbered ? null : line.match(HEADING)
    if (bullet || numbered) {
      paragraphOpen = false
      const indent = indentOf((bullet ?? numbered)![1]!)
      const spans = inlineSpans(bullet ? bullet[2]! : numbered![3]!)
      const list = last && (last.kind === 'ul' || last.kind === 'ol') ? last : null
      if (indent >= SUB_INDENT && list?.items.length) {
        list.items.at(-1)!.sub.push(spans)
        continue
      }
      const kind = bullet ? 'ul' : 'ol'
      if (list && list.kind === kind) list.items.push({ spans, sub: [] })
      else if (kind === 'ul') out.push({ kind, items: [{ spans, sub: [] }] })
      else out.push({ kind, start: Number(numbered![2]), items: [{ spans, sub: [] }] })
    } else if (heading) {
      paragraphOpen = false
      out.push({ kind: 'h', spans: inlineSpans(heading[1]!) })
    } else if (!line.trim()) {
      paragraphOpen = false
    } else if (paragraphOpen && last?.kind === 'p') {
      last.lines.push(inlineSpans(line.trim()))
    } else {
      out.push({ kind: 'p', lines: [inlineSpans(line.trim())] })
      paragraphOpen = true
    }
  }
  return out
}
