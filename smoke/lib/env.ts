// Smoke suite environment: test portal address (webhook). Pure functions — covered by a unit
// test (tests/smokeEnv.test.ts) with no network.
//
// Approach taken from ai-price-import (scripts/lib/envFile.mjs, testPortalGuard.mjs), along with
// the pitfalls it already hit:
// • the portal address is taken ONLY from a git-ignored file, never from environment variables: a
//   developer's shell may hold `B24_HOOK` for a different (production!) portal — prices have already
//   gone to the wrong place this way;
// • last occurrence of the key wins (dotenv semantics), quotes are stripped, `export KEY=` is
//   understood, a commented-out `#KEY=` and a suffixed key (`OLD_B24_HOOK`) are not picked up;
// • runs only against a portal from the test list; any other domain requires explicit consent
//   naming that exact domain: later stages will register providers on the portal (docs/PLAN.md).

/** Default git-ignored smoke env file (`.env.*` in .gitignore). */
export const DEFAULT_SMOKE_ENV_FILE = '.env.b24test'

/** Portals the smoke suite is allowed to run against. The domain is not secret; the secret is the webhook path code. */
export const TEST_PORTALS: ReadonlySet<string> = new Set([
  'b24-ypkv9c.bitrix24.by' // test portal for the invoice-from-tasks template (since 2026-09-24)
])

/**
 * Value of a key from `.env` text: last occurrence, unquoted, with `export` support.
 * No key or empty — `''`.
 */
export function readEnvValue(text: string, key: string): string {
  // `[ \t]*`, not `\s*`: `\s` would also match a newline, breaking the "start of line" anchor.
  const re = new RegExp(`^[ \\t]*(?:export[ \\t]+)?${key}=(.*)$`, 'gm')
  let value = ''
  for (const m of text.matchAll(re)) value = m[1] ?? ''
  return value.trim().replace(/^["']|["']$/g, '').trim()
}

export interface SmokeEnv {
  /** Webhook address (a secret — never included in output). */
  hook: string
  /** Portal host — for the guard and messages. */
  host: string
}

/** Environment from a file's text. No `B24_HOOK` — `null` (the whole smoke suite is skipped). */
export function parseSmokeEnv(fileText: string): SmokeEnv | null {
  const hook = readEnvValue(fileText, 'B24_HOOK')
  if (!hook) return null
  let host: string
  try {
    const url = new URL(hook)
    if (url.protocol !== 'https:') throw new Error('not https')
    host = url.host.toLowerCase()
  } catch {
    // The address itself is not included in the message: it contains the secret.
    throw new Error('B24_HOOK в файле окружения смока — не https-адрес вебхука')
  }
  return { hook, host }
}

/**
 * Guard: only a test portal may be used. Any other domain requires it to be explicitly named in
 * `B24_SMOKE_YES_TARGET` (no silent "probably a test portal" fallback).
 *
 * @throws Error explaining why, with a hint on how to give consent
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
