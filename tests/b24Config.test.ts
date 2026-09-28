import { describe, expect, it } from 'vitest'
import { sdkRestrictionParams } from '~/config/b24'

describe('настройки SDK фрейма', () => {
  it('без автоповторов при сетевых сбоях и 5xx — запись не должна уходить дважды', () => {
    const params = sdkRestrictionParams()
    expect(params.retryOnNetworkError).toBe(false)
    expect(params.hardErrorCodes).toContain('ERR_BAD_RESPONSE')
  })

  it('каждый раз новый объект: SDK не делит его с нашим кодом', () => {
    const a = sdkRestrictionParams()
    a.hardErrorCodes?.push('X')
    expect(sdkRestrictionParams().hardErrorCodes).toEqual(['ERR_BAD_RESPONSE'])
  })
})
