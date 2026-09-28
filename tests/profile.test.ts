import { describe, expect, it } from 'vitest'
import { isPortalAdmin } from '~/utils/profile'

describe('isPortalAdmin', () => {
  it('ADMIN: true from profile — admin', () => {
    expect(isPortalAdmin({ ID: '1', ADMIN: true }, false)).toBe(true)
  })

  it('only the boolean true counts: strings and truthy values do not', () => {
    expect(isPortalAdmin({ ADMIN: 'true' }, false)).toBe(false)
    expect(isPortalAdmin({ ADMIN: 'Y' }, false)).toBe(false)
    expect(isPortalAdmin({ ADMIN: 1 }, false)).toBe(false)
    expect(isPortalAdmin({ ADMIN: false }, false)).toBe(false)
  })

  it('frame flag is the fallback for a missing or broken answer', () => {
    expect(isPortalAdmin(null, true)).toBe(true)
    expect(isPortalAdmin(undefined, false)).toBe(false)
    expect(isPortalAdmin({ ADMIN: false }, true)).toBe(true)
  })
})
