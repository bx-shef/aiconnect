// Формы ответов REST, на которых стоит приложение (docs/REST_METHODS.md, ✅).
// Каждая проверка — замер: поменяется поведение портала — проверка покраснеет раньше пользователей.

import { beforeAll, describe, expect, inject, it } from 'vitest'
import { connectPortal, type Portal } from './lib/portal'

const env = inject('smokeEnv')

describe.skipIf(!env)('REST: формы ответов портала', () => {
  let portal: Portal
  beforeAll(() => {
    portal = connectPortal(env!.hook)
  })

  it('profile: ADMIN — логическое, ID — строка (строгая проверка `ADMIN === true` в frameAuth)', async () => {
    const p = await portal.call<{ ID?: unknown, ADMIN?: unknown }>('profile')
    expect(typeof p.ADMIN).toBe('boolean')
    expect(typeof p.ID).toBe('string')
  })

  it('scope: массив строк (страница установки сверяет его с B24_REQUIRED_SCOPES)', async () => {
    const scopes = await portal.call<unknown>('scope')
    expect(Array.isArray(scopes)).toBe(true)
    for (const s of scopes as unknown[]) expect(typeof s).toBe('string')
  })
})
