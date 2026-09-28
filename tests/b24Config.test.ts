import { describe, expect, it } from 'vitest'
import { sdkRestrictionParams } from '~/config/b24'

describe('frame SDK settings', () => {
  it('no auto-retries on network failures and 5xx — a write must not go out twice', () => {
    const params = sdkRestrictionParams()
    expect(params.retryOnNetworkError).toBe(false)
    expect(params.hardErrorCodes).toContain('ERR_BAD_RESPONSE')
  })

  it('a fresh object every time: the SDK does not share it with our code', () => {
    const a = sdkRestrictionParams()
    a.hardErrorCodes?.push('X')
    expect(sdkRestrictionParams().hardErrorCodes).toEqual(['ERR_BAD_RESPONSE'])
  })
})
