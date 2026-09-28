// Общая подготовка смок-набора (vitest globalSetup): окружение, страж портала, данные прогона.
// Нет файла или вебхука — `fixture: null`, и наборы пропускаются: `pnpm smoke` без окружения
// ничего не пишет и не падает.

import { readFileSync } from 'node:fs'
import type { TestProject } from 'vitest/node'
import { assertTestPortal, DEFAULT_SMOKE_ENV_FILE, parseSmokeEnv, type SmokeEnv } from './lib/env'
import { connectPortal } from './lib/portal'
import { seed, type SmokeFixture } from './lib/seed'

declare module 'vitest' {
  export interface ProvidedContext {
    smokeEnv: SmokeEnv | null
    fixture: SmokeFixture | null
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
  if (!env) {
    project.provide('smokeEnv', null)
    project.provide('fixture', null)
    return
  }
  assertTestPortal(env.host, process.env.B24_SMOKE_YES_TARGET ?? '')
  console.log(`[smoke] портал ${env.host}; BitrixGPT: ${env.aiKey ? 'есть ключ' : 'нет ключа — пропуск'}`)
  const fixture = await seed(connectPortal(env.hook))
  console.log(`[smoke] данные прогона: «${fixture.runTag}», сделка ${fixture.dealId}, счета ${Object.values(fixture.invoices).join(', ')}`)
  project.provide('smokeEnv', env)
  project.provide('fixture', fixture)
}
