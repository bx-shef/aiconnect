import { describe, expect, it } from 'vitest'
import { oauthCredsFromEnv, oauthParams, restCallFrom, type SdkCallClient } from '../../server/utils/b24Client'

const token = { domain: 'https://Demo.bitrix24.ru/', memberId: 'm1', accessToken: 'a', refreshToken: 'r', expiresAt: 10_000_000, applicationToken: 't' }

describe('oauthParams', () => {
  it('expiry in seconds, domain and REST address — clean host', () => {
    const p = oauthParams(token, 4_000_000)
    expect(p).toMatchObject({ domain: 'demo.bitrix24.ru', clientEndpoint: 'https://demo.bitrix24.ru/rest/', expires: 10_000, expiresIn: 6000 })
  })

  it('auth server — portal-specific, defaults to current', () => {
    expect(oauthParams({ ...token, oauthHost: 'oauth.bitrix.info' }, 0).serverEndpoint).toBe('https://oauth.bitrix.info/rest/')
    expect(oauthParams(token, 0).serverEndpoint).toBe('https://oauth.bitrix24.tech/rest/')
  })

  it('expired token — expiresIn is 0, not negative', () => {
    expect(oauthParams(token, 20_000_000).expiresIn).toBe(0)
  })

  it('host is not Bitrix24 — throws (SSRF guard)', () => {
    expect(() => oauthParams({ ...token, domain: 'evil.com' }, 0)).toThrow()
  })
})

function sdk(res: { isSuccess: boolean, data?: unknown, errors?: string[] }): SdkCallClient {
  return {
    actions: { v2: { call: { make: async () => ({
      isSuccess: res.isSuccess,
      getData: () => (res.data === undefined ? undefined : { result: res.data }),
      getErrorMessages: () => res.errors ?? []
    }) } } }
  }
}

describe('restCallFrom', () => {
  it('unwraps the `result` envelope', async () => {
    expect(await restCallFrom(sdk({ isSuccess: true, data: { ID: 1 } }))('profile')).toEqual({ ID: 1 })
    expect(await restCallFrom(sdk({ isSuccess: true }))('profile')).toBeUndefined()
  })

  it('portal error — throws with method name and portal text', async () => {
    await expect(restCallFrom(sdk({ isSuccess: false, errors: ['ACCESS_DENIED', 'no permission'] }))('app.option.set'))
      .rejects.toThrow('app.option.set: ACCESS_DENIED; no permission')
    await expect(restCallFrom(sdk({ isSuccess: false }))('x')).rejects.toThrow('x: unknown error')
  })
})

describe('oauthCredsFromEnv', () => {
  it('trims whitespace; missing value — empty string', () => {
    expect(oauthCredsFromEnv({ B24_CLIENT_ID: ' id ', B24_CLIENT_SECRET: undefined })).toEqual({ clientId: 'id', clientSecret: '' })
  })
})
