// Общая часть AI-эндпоинтов: лимит частоты и вызов BitrixGPT с повторами.
// Без автоимпортов Nitro (конвенция CLAUDE.md): ошибки — свой класс, в HTTP-ответ их переводит
// `requestContext.ts → aiHttpError`. Так модуль тестируется в node без Nitro.

import { chatWithRetry, describeLlmFailure, makeChatFn, resolveLlmConfig, type ChatFn, type ChatRequest } from './llm'
import { AI_LIMITS, SlidingWindow } from './rateLimit'
import type { FrameUser } from './frameAuth'

export interface AiLimitOptions {
  /** Сколько строк несёт обращение: число строк в запросе названий, `CONSULT_WEIGHT` для консультации. */
  weight?: number
  window?: SlidingWindow
  now?: number
}

/** Отказ AI-шлюза с HTTP-кодом и текстом для сотрудника (без сырого текста провайдера). */
export class AiGatewayError extends Error {
  constructor(readonly statusCode: 429 | 502, message: string) {
    super(message)
    this.name = 'AiGatewayError'
  }
}

const windows = new SlidingWindow()

/** Бросает {@link AiGatewayError} 429, если сотрудник или портал исчерпали лимит обращений. */
export function enforceAiLimit(user: FrameUser, opts: AiLimitOptions = {}): void {
  // Два измерения сразу (rateLimit.ts): число вызовов модели и число строк в них.
  const rows = opts.weight ?? 1
  const who = `${user.portal.memberId}:${user.userId}`
  const ok = (opts.window ?? windows).take([
    [`ur:${who}`, AI_LIMITS.userRequests, 1],
    [`uw:${who}`, AI_LIMITS.userRows, rows],
    [`pr:${user.portal.memberId}`, AI_LIMITS.portalRequests, 1],
    [`pw:${user.portal.memberId}`, AI_LIMITS.portalRows, rows]
  ], opts.now ?? Date.now())
  if (!ok) throw new AiGatewayError(429, 'Слишком много обращений к BitrixGPT. Попробуйте позже.')
}

let liveChat: ChatFn | null = null

/**
 * Вызов BitrixGPT. Ошибка превращается в {@link AiGatewayError} 502 с понятным текстом; в журнал —
 * только класс отказа (сырой ответ провайдера может цитировать описания задач).
 */
export async function askBitrixGpt(req: ChatRequest, chat?: ChatFn): Promise<string> {
  const fn = chat ?? (liveChat ??= makeChatFn(resolveLlmConfig(process.env)))
  try {
    return await chatWithRetry(fn, req)
  } catch (e) {
    const failure = describeLlmFailure(e instanceof Error ? e.message : String(e))
    console.error(`[bitrixgpt] failure kind=${failure.kind}`)
    throw new AiGatewayError(502, failure.message)
  }
}
