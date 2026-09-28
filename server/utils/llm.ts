// BitrixGPT: OpenAI-совместимый транспорт к Bitrix Vibecode AI Router. Схема перенесена из
// ai-price-import (server/agent/llmConfig.ts, openaiChat.ts, retry.ts, extractJson.ts,
// llmFailure.ts) и сжата под наши два сценария: названия строк и консультация.
//
// Ключ живёт ТОЛЬКО на сервере (переменная окружения), во фрейм он не попадает никогда —
// поэтому BitrixGPT и зовётся через наш /api, а не из браузера.

import OpenAI from 'openai'
import type { ChatMessage } from '#shared/domain/prompts'

export interface LlmConfig {
  baseURL: string
  /** Пустая строка — ключ не задан; транспорт тогда отказывает с понятной ошибкой. */
  apiKey: string
  model: string
}

/** Значения по умолчанию — как в ai-price-import: AI Router Вайбкода и модель BitrixGPT. */
export const BITRIXGPT_DEFAULTS = {
  baseURL: 'https://vibecode.bitrix24.tech/v1',
  model: 'bitrix/bitrixgpt-5.5'
} as const

/**
 * Конфигурация из окружения. `BITRIXGPT_API_KEY` приоритетнее общего `VIBE_API_KEY`.
 * ⚠ Ключ должен быть ключом Вайбкода (`vibe_…`): AI Router принимает `Authorization: Bearer`
 * только для них (замер ai-price-import, их .env.example).
 */
export function resolveLlmConfig(env: Record<string, string | undefined>): LlmConfig {
  return {
    baseURL: env.BITRIXGPT_BASE_URL?.trim() || BITRIXGPT_DEFAULTS.baseURL,
    apiKey: env.BITRIXGPT_API_KEY?.trim() || env.VIBE_API_KEY?.trim() || '',
    model: env.BITRIXGPT_MODEL?.trim() || BITRIXGPT_DEFAULTS.model
  }
}

export const CHAT_TIMEOUT_MS = 120_000

export interface ChatRequest {
  messages: ChatMessage[]
  /** `json_object` — для названий строк; для консультации — обычный текст. */
  json: boolean
}

export type ChatFn = (req: ChatRequest) => Promise<string>

/**
 * Приводит ошибку SDK к строке, которую понимает классификатор: HTTP-статус или сетевой код
 * впереди. Ключ в эти поля SDK не кладёт — утечки секрета нет.
 */
export function normaliseError(e: unknown): Error {
  const err = e as { status?: unknown, code?: unknown, cause?: { code?: unknown } }
  const msg = e instanceof Error ? e.message : String(e)
  if (typeof err?.status === 'number') return new Error(`${err.status} ${msg}`)
  const netCode = [err?.code, err?.cause?.code].find(v => typeof v === 'string') as string | undefined
  return new Error(netCode ? `${netCode} ${msg}` : msg)
}

/** Живой транспорт. Повторы внутри SDK выключены — политикой повторов владеет `chatWithRetry`. */
export function makeChatFn(config: LlmConfig, timeoutMs = CHAT_TIMEOUT_MS): ChatFn {
  if (!config.apiKey) {
    return async () => {
      throw new Error('LLM provider not configured (missing API key)')
    }
  }
  const client = new OpenAI({ baseURL: config.baseURL, apiKey: config.apiKey, timeout: timeoutMs, maxRetries: 0 })
  return async (req) => {
    try {
      const res = await client.chat.completions.create({
        model: config.model,
        messages: req.messages,
        temperature: 0.2,
        ...(req.json ? { response_format: { type: 'json_object' as const } } : {}),
        stream: false
      })
      return res.choices?.[0]?.message?.content ?? ''
    } catch (e) {
      throw normaliseError(e)
    }
  }
}

const TRANSIENT_PATTERNS = [
  /\b429\b/, /\b5\d\d\b/, /rate.?limit/i, /overloaded/i, /gateway.?timeout/i,
  /ECONNRESET/i, /ETIMEDOUT/i, /ENOTFOUND/i, /EAI_AGAIN/i, /socket hang up/i
]

/** Временная ли ошибка (стоит повторить) или окончательная. */
export function isTransient(message: string): boolean {
  return TRANSIENT_PATTERNS.some(re => re.test(message ?? ''))
}

/** Пауза перед попыткой N: 1 с · 2^(N−1), не больше 30 с, с разбросом 50–100 %. */
export function backoffMs(attempt: number, jitter: number): number {
  const exp = Math.min(30_000, 1000 * 2 ** Math.max(0, attempt - 1))
  return Math.round(exp * (0.5 + 0.5 * Math.max(0, Math.min(1, jitter))))
}

export interface RetryDeps {
  sleep?: (ms: number) => Promise<void>
  random?: () => number
  maxAttempts?: number
}

/** Вызов с повторами временных ошибок. Окончательная ошибка пробрасывается сразу. */
export async function chatWithRetry(chat: ChatFn, req: ChatRequest, deps: RetryDeps = {}): Promise<string> {
  const sleep = deps.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)))
  const random = deps.random ?? Math.random
  const maxAttempts = deps.maxAttempts ?? 3
  let attempt = 0
  for (;;) {
    attempt++
    try {
      return await chat(req)
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      if (!isTransient(message) || attempt >= maxAttempts) throw e
      await sleep(backoffMs(attempt, random()))
    }
  }
}

/** Последний сбалансированный JSON-объект в ответе, который разбирается; иначе `null`. */
export function extractJson(output: string): unknown {
  if (!output || output.length > 2_000_000) return null
  const spans: Array<[number, number]> = []
  let depth = 0
  let start = -1
  let inStr = false
  let esc = false
  for (let i = 0; i < output.length; i++) {
    const ch = output[i]!
    if (inStr) {
      if (esc) esc = false
      else if (ch === '\\') esc = true
      else if (ch === '"') inStr = false
      continue
    }
    if (ch === '"') inStr = true
    else if (ch === '{') {
      if (depth === 0) start = i
      depth++
    } else if (ch === '}' && depth > 0) {
      depth--
      if (depth === 0 && start >= 0) spans.push([start, i])
    }
  }
  for (let s = spans.length - 1; s >= 0; s--) {
    try {
      return JSON.parse(output.slice(spans[s]![0], spans[s]![1] + 1))
    } catch {
      // Не разобралось — пробуем предыдущий кандидат.
    }
  }
  return null
}

export type LlmFailureKind = 'auth' | 'quota' | 'too-long' | 'unavailable' | 'unknown'

const FAILURE_PATTERNS: Array<[LlmFailureKind, RegExp]> = [
  ['auth', /missing api key|not configured|invalid.?api.?key|unauthor|forbidden|\b401\b|\b403\b|authentication/i],
  ['quota', /quota|insufficient_quota|billing|\b429\b|rate.?limit|too many requests/i],
  ['too-long', /context.?length|maximum context|too many tokens|token limit|too long/i],
  ['unavailable', /\b5\d\d\b|overloaded|gateway|unavailable|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up|timed? ?out|network/i]
]

const FAILURE_MESSAGES: Record<LlmFailureKind, string> = {
  'auth': 'BitrixGPT отклонил доступ приложения (ключ не задан или недействителен). Сообщите администратору приложения.',
  'quota': 'Исчерпан лимит обращений к BitrixGPT. Попробуйте позже или сообщите администратору приложения.',
  'too-long': 'Слишком много текста для BitrixGPT. Уменьшите число задач или сократите описания.',
  'unavailable': 'BitrixGPT временно недоступен. Попробуйте через несколько минут.',
  'unknown': 'BitrixGPT не ответил: причина не определена. Попробуйте ещё раз.'
}

/**
 * Текст отказа для сотрудника. Сырой текст провайдера наружу НЕ отдаём: он может цитировать
 * присланные данные (описания задач). В журнал — только класс.
 */
export function describeLlmFailure(raw: string): { kind: LlmFailureKind, message: string } {
  const kind = FAILURE_PATTERNS.find(([, re]) => re.test(raw ?? ''))?.[0] ?? 'unknown'
  return { kind, message: FAILURE_MESSAGES[kind] }
}
