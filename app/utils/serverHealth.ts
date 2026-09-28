// What isn't configured on the app server — from the GET /api/health response (flags "set / not set",
// no secrets). Shown to the admin on the main page: without B24_APP_CODE the server responds with 503
// to all requests from the portal, and the app code is only visible from inside the portal (`app.info`).
// The install page doesn't work for this: the portal reloads it after installFinish.

export interface HealthConfig {
  appCode?: unknown
  oauth?: unknown
  tokenKey?: unknown
}

export interface ServerProblem {
  /** The environment variable that needs to be set. */
  variable: string
  /** What doesn't work without it. */
  effect: string
  /** Without this the app doesn't work at all (otherwise — some features don't work). */
  blocking: boolean
}

/** Server configuration problems; an empty list means everything is set. An unknown response yields no findings. */
export function serverProblems(health: unknown): ServerProblem[] {
  const config = (health as { config?: HealthConfig } | null)?.config
  if (!config || typeof config !== 'object') return []
  const out: ServerProblem[] = []
  if (config.appCode === false) out.push({ variable: 'B24_APP_CODE', effect: 'сервер отклоняет запросы из портала', blocking: true })
  if (config.oauth === false) out.push({ variable: 'B24_CLIENT_ID, B24_CLIENT_SECRET', effect: 'установка не сохраняется на сервере', blocking: true })
  if (config.tokenKey === false) out.push({ variable: 'B24_TOKEN_ENC_KEY', effect: 'установка не сохраняется на сервере', blocking: true })
  return out
}
