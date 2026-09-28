// Окружение смок-набора: адрес тестового портала (вебхук). Чистые функции — проверяются
// юнит-тестом (tests/smokeEnv.test.ts) без сети.
//
// Подход — из ai-price-import (scripts/lib/envFile.mjs, testPortalGuard.mjs), с их граблями:
// • адрес портала берётся ТОЛЬКО из git-ignored файла, не из переменных окружения: в оболочке
//   разработчика может жить `B24_HOOK` другого (боевого!) портала — так в прайсах уже уходили не туда;
// • последнее вхождение ключа (семантика dotenv), кавычки снимаются, `export KEY=` понимается,
//   закомментированный `#KEY=` и ключ-суффикс (`OLD_B24_HOOK`) не подхватываются;
// • запуск только на портале из списка тестовых, иной домен — лишь по явному согласию с названным
//   доменом: следующие этапы будут регистрировать провайдеров в портале (docs/PLAN.md).

/** Git-ignored файл окружения смока по умолчанию (`.env.*` в .gitignore). */
export const DEFAULT_SMOKE_ENV_FILE = '.env.b24test'

/** Порталы, на которых смоку разрешено работать. Домен — не секрет; секрет — код в пути вебхука. */
export const TEST_PORTALS: ReadonlySet<string> = new Set([
  'b24-ypkv9c.bitrix24.by' // тестовый портал aiconnect (владелец, 2026-09-28); раньше — шаблона invoice-from-tasks
])

/**
 * Значение ключа из текста `.env`: последнее вхождение, без кавычек, с поддержкой `export`.
 * Нет ключа или пусто — `''`.
 */
export function readEnvValue(text: string, key: string): string {
  // `[ \t]*`, не `\s*`: `\s` захватил бы перевод строки, и якорь «начало строки» перестал бы быть правдой.
  const re = new RegExp(`^[ \\t]*(?:export[ \\t]+)?${key}=(.*)$`, 'gm')
  let value = ''
  for (const m of text.matchAll(re)) value = m[1] ?? ''
  return value.trim().replace(/^["']|["']$/g, '').trim()
}

export interface SmokeEnv {
  /** Адрес вебхука (секрет — в выводе не показывается). */
  hook: string
  /** Хост портала — для стража и сообщений. */
  host: string
}

/** Окружение из текста файла. Нет `B24_HOOK` — `null` (смок пропускается целиком). */
export function parseSmokeEnv(fileText: string): SmokeEnv | null {
  const hook = readEnvValue(fileText, 'B24_HOOK')
  if (!hook) return null
  let host: string
  try {
    const url = new URL(hook)
    if (url.protocol !== 'https:') throw new Error('not https')
    host = url.host.toLowerCase()
  } catch {
    // Сам адрес в сообщение не кладём: в нём секрет.
    throw new Error('B24_HOOK в файле окружения смока — не https-адрес вебхука')
  }
  return { hook, host }
}

/**
 * Страж: работать можно только с тестовым порталом. Другой домен — только если он назван явно в
 * `B24_SMOKE_YES_TARGET` (молчаливого «наверное, тестовый» нет).
 *
 * @throws Error с объяснением и подсказкой, как дать согласие
 */
export function assertTestPortal(host: string, yesTarget = ''): void {
  if (TEST_PORTALS.has(host)) return
  if (yesTarget.trim().toLowerCase() === host) return
  throw new Error(
    `Смок отказался работать с ${host}: портал не в списке тестовых (smoke/lib/env.ts → TEST_PORTALS). `
    + 'Уверены, что портал тестовый, — '
    + `запустите с B24_SMOKE_YES_TARGET=${host}.`
  )
}
