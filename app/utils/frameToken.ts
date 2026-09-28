// Свежесть фрейм-токена перед запросом к нашему серверу. Чистая функция — тестируется в node.

/** Запас до истечения токена: обновляем заранее, чтобы он не умер по дороге к серверу и порталу. */
export const TOKEN_REFRESH_MARGIN_MS = 60_000

/** Нужно ли обновить токен фрейма. `expires` в SDK — секунды эпохи (frame/auth.mjs пакета 2.2.0). */
export function tokenNeedsRefresh(auth: false | { expires: number }, nowMs = Date.now()): boolean {
  return !auth || auth.expires * 1000 - nowMs < TOKEN_REFRESH_MARGIN_MS
}
