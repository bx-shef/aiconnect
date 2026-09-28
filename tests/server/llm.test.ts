import { describe, expect, it, vi } from 'vitest'
import { backoffMs, BITRIXGPT_DEFAULTS, chatWithRetry, describeLlmFailure, extractJson, isTransient, makeChatFn, normaliseError, resolveLlmConfig } from '../../server/utils/llm'

describe('конфигурация BitrixGPT', () => {
  it('по умолчанию — AI Router Вайбкода и модель BitrixGPT', () => {
    expect(resolveLlmConfig({})).toEqual({ ...BITRIXGPT_DEFAULTS, apiKey: '' })
  })

  it('свой ключ приоритетнее общего VIBE_API_KEY', () => {
    expect(resolveLlmConfig({ VIBE_API_KEY: 'vibe_a', BITRIXGPT_API_KEY: 'vibe_b' }).apiKey).toBe('vibe_b')
    expect(resolveLlmConfig({ VIBE_API_KEY: 'vibe_a' }).apiKey).toBe('vibe_a')
  })

  it('без ключа транспорт отказывает понятной ошибкой, а не 401 на каждый запрос', async () => {
    const chat = makeChatFn({ ...BITRIXGPT_DEFAULTS, apiKey: '' })
    await expect(chat({ messages: [], json: true })).rejects.toThrow(/missing API key/)
  })
})

describe('повторы', () => {
  it('временные ошибки повторяются, окончательные — нет', async () => {
    const sleep = vi.fn(async () => {})
    let n = 0
    const flaky = async () => {
      n++
      if (n < 3) throw new Error('503 Service Unavailable')
      return 'ok'
    }
    expect(await chatWithRetry(flaky, { messages: [], json: false }, { sleep, random: () => 0 })).toBe('ok')
    expect(sleep).toHaveBeenCalledTimes(2)

    const fatal = vi.fn(async () => {
      throw new Error('401 Unauthorized')
    })
    await expect(chatWithRetry(fatal, { messages: [], json: false }, { sleep })).rejects.toThrow('401')
    expect(fatal).toHaveBeenCalledTimes(1)
  })

  it('не больше трёх попыток', async () => {
    const always = vi.fn(async () => {
      throw new Error('429 Too Many Requests')
    })
    await expect(chatWithRetry(always, { messages: [], json: false }, { sleep: async () => {} })).rejects.toThrow('429')
    expect(always).toHaveBeenCalledTimes(3)
  })

  it('пауза растёт и ограничена 30 секундами', () => {
    expect(backoffMs(1, 1)).toBe(1000)
    expect(backoffMs(2, 1)).toBe(2000)
    expect(backoffMs(10, 1)).toBe(30_000)
    expect(backoffMs(1, 0)).toBe(500)
  })

  it('сетевой код ошибки попадает в сообщение — классификатор его видит', () => {
    const e = Object.assign(new Error('Connection error.'), { cause: { code: 'ECONNRESET' } })
    expect(isTransient(normaliseError(e).message)).toBe(true)
    expect(normaliseError(Object.assign(new Error('x'), { status: 429 })).message).toBe('429 x')
  })
})

describe('разбор ответа модели', () => {
  it('берёт последний разбираемый JSON-объект, даже в обёртке текста', () => {
    expect(extractJson('Вот ответ: {"a":1} и ещё {"t1":"Название {в скобках}"}')).toEqual({ t1: 'Название {в скобках}' })
    expect(extractJson('без json')).toBeNull()
  })
})

describe('отказы BitrixGPT для сотрудника', () => {
  it('сырой текст провайдера наружу не уходит', () => {
    const f = describeLlmFailure('500 upstream error: prompt contained «секретный клиент»')
    expect(f.kind).toBe('unavailable')
    expect(f.message).not.toContain('секретный')
  })

  it('классы: ключ, лимит, длина, неизвестно', () => {
    expect(describeLlmFailure('LLM provider not configured (missing API key)').kind).toBe('auth')
    expect(describeLlmFailure('429 rate limit').kind).toBe('quota')
    expect(describeLlmFailure('maximum context length exceeded').kind).toBe('too-long')
    expect(describeLlmFailure('странное').kind).toBe('unknown')
  })
})
