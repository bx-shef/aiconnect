// REST response shapes the application relies on (docs/REST_METHODS.md, checked).
// Each check is a tripwire: if the portal's behavior changes, the check turns red before users notice.

import { beforeAll, describe, expect, inject, it } from 'vitest'
import { connectPortal, type Portal } from './lib/portal'

const env = inject('smokeEnv')

describe.skipIf(!env)('REST: portal response shapes', () => {
  let portal: Portal
  beforeAll(() => {
    portal = connectPortal(env!.hook)
  })

  it('profile: ADMIN is boolean, ID is a string (frameAuth does a strict `ADMIN === true` check)', async () => {
    const p = await portal.call<{ ID?: unknown, ADMIN?: unknown }>('profile')
    expect(typeof p.ADMIN).toBe('boolean')
    expect(typeof p.ID).toBe('string')
  })

  it('scope: an array of strings (the install page checks it against B24_REQUIRED_SCOPES)', async () => {
    const scopes = await portal.call<unknown>('scope')
    expect(Array.isArray(scopes)).toBe(true)
    for (const s of scopes as unknown[]) expect(typeof s).toBe('string')
  })
})
