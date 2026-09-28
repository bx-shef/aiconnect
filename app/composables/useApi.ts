// Запросы к НАШЕМУ серверу (/api) с фрейм-токеном в заголовках. Сервер проверяет токен
// сам (server/utils/frameAuth.ts) — заголовки здесь лишь сообщают, кто пришёл.

import { tokenNeedsRefresh } from '~/utils/frameToken'

export class ApiError extends Error {
  constructor(readonly status: number, message: string, readonly data?: unknown) {
    super(message)
    this.name = 'ApiError'
  }
}

export function useApi() {
  const { getOrThrow } = useB24()

  async function authHeaders(): Promise<Record<string, string>> {
    const frame = getOrThrow()
    const current = frame.auth.getAuthData()
    const auth = tokenNeedsRefresh(current) ? await frame.auth.refreshAuth() : current as Exclude<typeof current, false>
    // `domain` у SDK — с протоколом (getTargetOrigin); сервер вынимает из него хост сам.
    return { 'Authorization': `Bearer ${auth.access_token}`, 'X-B24-Domain': auth.domain }
  }

  /** POST в наш API. Ошибку сервера превращает в {@link ApiError} с его текстом. */
  async function post<T>(url: string, body: unknown): Promise<T> {
    try {
      const res = await $fetch(url, { method: 'POST', body: body as Record<string, unknown>, headers: await authHeaders() })
      return res as T
    } catch (e) {
      const err = e as { statusCode?: number, statusMessage?: string, data?: { statusMessage?: string, error?: string } }
      const message = err.data?.statusMessage || err.data?.error || err.statusMessage || 'Сервер приложения не ответил'
      throw new ApiError(err.statusCode ?? 0, message, err.data)
    }
  }

  return { post }
}
