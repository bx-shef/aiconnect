import { describe, expect, it } from 'vitest'
import { oauthCredsFromEnv, oauthParams, restCallFrom, type SdkCallClient } from '../../server/utils/b24Client'

const token = { domain: 'https://Demo.bitrix24.ru/', memberId: 'm1', accessToken: 'a', refreshToken: 'r', expiresAt: 10_000_000, applicationToken: 't' }

describe('oauthParams', () => {
  it('срок — в секундах, домен и REST-адрес — чистый хост', () => {
    const p = oauthParams(token, 4_000_000)
    expect(p).toMatchObject({ domain: 'demo.bitrix24.ru', clientEndpoint: 'https://demo.bitrix24.ru/rest/', expires: 10_000, expiresIn: 6000 })
  })

  it('сервер авторизации — свой у портала, по умолчанию — текущий', () => {
    expect(oauthParams({ ...token, oauthHost: 'oauth.bitrix.info' }, 0).serverEndpoint).toBe('https://oauth.bitrix.info/rest/')
    expect(oauthParams(token, 0).serverEndpoint).toBe('https://oauth.bitrix24.tech/rest/')
  })

  it('просроченный токен — expiresIn 0, а не отрицательный', () => {
    expect(oauthParams(token, 20_000_000).expiresIn).toBe(0)
  })

  it('хост не Битрикс24 — исключение (SSRF-гард)', () => {
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
  it('разворачивает конверт `result`', async () => {
    expect(await restCallFrom(sdk({ isSuccess: true, data: { ID: 1 } }))('profile')).toEqual({ ID: 1 })
    expect(await restCallFrom(sdk({ isSuccess: true }))('profile')).toBeUndefined()
  })

  it('ошибка портала — исключение с именем метода и текстом портала', async () => {
    await expect(restCallFrom(sdk({ isSuccess: false, errors: ['ACCESS_DENIED', 'нет прав'] }))('app.option.set'))
      .rejects.toThrow('app.option.set: ACCESS_DENIED; нет прав')
    await expect(restCallFrom(sdk({ isSuccess: false }))('x')).rejects.toThrow('x: unknown error')
  })
})

describe('oauthCredsFromEnv', () => {
  it('обрезает пробелы; нет значения — пустая строка', () => {
    expect(oauthCredsFromEnv({ B24_CLIENT_ID: ' id ', B24_CLIENT_SECRET: undefined })).toEqual({ clientId: 'id', clientSecret: '' })
  })
})
