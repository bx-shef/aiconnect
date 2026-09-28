// Разбор запросов к AI-эндпоинтам — чистые функции над телом запроса и настройками портала.
// Пределы и фильтры проверяются тестом (tests/server/aiRequests.test.ts): раньше они жили в
// Nitro-обработчиках, и их можно было удалить при зелёных тестах (находка /code-review).

import type { FillMode } from '#shared/domain/fill'
import { MAX_NAMING_ITEMS, type NamingItem } from '#shared/domain/prompts'
import type { AppSettings, ConsultPrompt } from '#shared/domain/settings'

/** Итог разбора: значение или HTTP-отказ с текстом для журнала. */
export type Parsed<T>
  = | { ok: true, value: T }
    | { ok: false, status: 400 | 404 | 413, error: string }

/** Ключ строки счёта: `t<ID задачи>` или `e<ID записи времени>` (`DraftRow.key`). */
const ROW_KEY = /^[te]\d{1,12}$/

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

/** Элементы запроса названий: только с правильным ключом; нестроковые поля — пустые. */
function parseItems(raw: unknown): NamingItem[] {
  if (!Array.isArray(raw)) return []
  const out: NamingItem[] = []
  for (const item of raw) {
    const o = asObject(item)
    const key = typeof o.key === 'string' ? o.key : ''
    if (!ROW_KEY.test(key)) continue
    out.push({
      key,
      title: typeof o.title === 'string' ? o.title : '',
      text: typeof o.text === 'string' ? o.text : '',
      ...(typeof o.result === 'string' ? { result: o.result } : {})
    })
  }
  return out
}

/**
 * Тело POST /api/ai/names. Больше {@link MAX_NAMING_ITEMS} элементов — 413, а не молчаливая
 * обрезка: обрезанные строки вернулись бы без названий. Страница режет строки на пакеты сама.
 */
export function parseNamingRequest(body: unknown): Parsed<{ mode: FillMode, items: NamingItem[] }> {
  const b = asObject(body)
  const mode = b.mode === 'task' || b.mode === 'time' ? b.mode : null
  if (Array.isArray(b.items) && b.items.length > MAX_NAMING_ITEMS) {
    return { ok: false, status: 413, error: `at most ${MAX_NAMING_ITEMS} items per request` }
  }
  const items = parseItems(b.items)
  if (!mode || items.length === 0) return { ok: false, status: 400, error: 'mode and items required' }
  return { ok: true, value: { mode, items } }
}

/**
 * Тело POST /api/ai/consult: id промпта и контекст. Проверяется ДО чтения настроек портала —
 * некорректный запрос не должен стоить вызова в портал (находка /code-review). Контекст — как
 * прислан (его урезают и страница, и `buildConsultMessages`).
 */
export function parseConsultRequest(body: unknown): Parsed<{ promptId: string, context: unknown }> {
  const b = asObject(body)
  const promptId = typeof b.promptId === 'string' ? b.promptId : ''
  if (!promptId) return { ok: false, status: 400, error: 'promptId required' }
  return { ok: true, value: { promptId, context: b.context ?? {} } }
}

/**
 * Промпт консультации по id — из настроек ПОРТАЛА, а не из тела запроса: иначе эндпоинт стал бы
 * бесплатным доступом к модели с любым промптом.
 */
export function findConsultPrompt(settings: AppSettings, promptId: string): Parsed<ConsultPrompt> {
  const prompt = settings.consultPrompts.find(p => p.id === promptId)
  return prompt ? { ok: true, value: prompt } : { ok: false, status: 404, error: 'prompt not found' }
}
