// Что не настроено на сервере приложения — по ответу GET /api/health (флаги «задано / нет»,
// без секретов). Показывается администратору на главной: без B24_APP_CODE сервер отвечает 503
// на все запросы из портала, а код приложения видно только изнутри портала (`app.info`).
// Раньше подсказку показывала страница установки — но после installFinish портал её
// перезагружает, и подсказку никто не видел (находка /code-review).

export interface HealthConfig {
  appCode?: unknown
  oauth?: unknown
  tokenKey?: unknown
  bitrixGpt?: unknown
}

export interface ServerProblem {
  /** Переменная окружения, которую нужно задать. */
  variable: string
  /** Что не работает без неё. */
  effect: string
  /** Без этого приложение не работает совсем (иначе — не работает часть функций). */
  blocking: boolean
}

/** Проблемы настройки сервера; пустой список — всё задано. Неизвестный ответ — без выводов. */
export function serverProblems(health: unknown): ServerProblem[] {
  const config = (health as { config?: HealthConfig } | null)?.config
  if (!config || typeof config !== 'object') return []
  const out: ServerProblem[] = []
  if (config.appCode === false) out.push({ variable: 'B24_APP_CODE', effect: 'сервер отклоняет запросы из портала: BitrixGPT, сохранение настроек и ставок', blocking: true })
  if (config.oauth === false) out.push({ variable: 'B24_CLIENT_ID, B24_CLIENT_SECRET', effect: 'установка не сохраняется на сервере: не работают BitrixGPT и запись ставок не-администраторами', blocking: true })
  if (config.tokenKey === false) out.push({ variable: 'B24_TOKEN_ENC_KEY', effect: 'установка не сохраняется на сервере', blocking: true })
  if (config.bitrixGpt === false) out.push({ variable: 'VIBE_API_KEY', effect: 'не работают названия строк через BitrixGPT и консультации', blocking: false })
  return out
}
