// Какая сборка запущена — для GET /api/health. Коммит зашивает в образ CI (Dockerfile, ARG
// COMMIT_SHA): по нему с сервера видно, докатил ли Watchtower новый образ, и на какой
// `sha-<7 знаков>` откатываться (docs/DEPLOY.md, «Откат»).

/** Сколько знаков коммита отдаём: столько же в теге образа `sha-…` (docker/metadata-action). */
export const SHORT_SHA = 7

/**
 * Короткий коммит сборки из окружения. Принимается только полный SHA git (40 шестнадцатеричных
 * знаков), наружу — первые {@link SHORT_SHA}: health открыт без входа, поэтому ни произвольный
 * текст из переменной (вдруг туда по ошибке попало чужое), ни полный отпечаток версии не отдаём
 * (ревью безопасности на #16) — короткого хватает, чтобы найти тег `sha-…` для отката.
 *
 * @returns 7 знаков SHA в нижнем регистре или `null`: не задан (локальная сборка) или не похож на SHA
 */
export function buildCommit(raw: string | undefined): string | null {
  const value = raw?.trim().toLowerCase() ?? ''
  return /^[0-9a-f]{40}$/.test(value) ? value.slice(0, SHORT_SHA) : null
}
