// Общая подготовка смок-набора (vitest globalSetup): окружение и страж портала.
// Нет файла или вебхука — `smokeEnv: null`, и наборы пропускаются: `pnpm smoke` без окружения
// ничего не делает и не падает.

import { readFileSync } from 'node:fs'
import type { TestProject } from 'vitest/node'
import { assertTestPortal, DEFAULT_SMOKE_ENV_FILE, parseSmokeEnv, type SmokeEnv } from './lib/env'

declare module 'vitest' {
  export interface ProvidedContext {
    smokeEnv: SmokeEnv | null
  }
}

export default async function setup(project: TestProject): Promise<void> {
  const file = process.env.SMOKE_ENV_FILE?.trim() || DEFAULT_SMOKE_ENV_FILE
  let text = ''
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    console.warn(`[smoke] нет файла ${file} — смок пропущен (docs/SMOKE.md)`)
  }
  const env = text ? parseSmokeEnv(text) : null
  if (env) {
    assertTestPortal(env.host, process.env.B24_SMOKE_YES_TARGET ?? '')
    console.log(`[smoke] портал ${env.host}`)
  }
  project.provide('smokeEnv', env)
}
