import { describe, expect, it } from 'vitest'
import { appForPortal, oauthCredsFromEnv, spyAppsState, spyBoxApp, spyBoxState, oauthParams, restCallFrom, type SdkCallClient } from '../../server/utils/b24Client'

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

describe('spyBoxApp / appForPortal (коробка-стенд шпиона)', () => {
  const BOX = 'stand.example.by'
  const env = (over: Record<string, string> = {}) => ({
    B24_CLIENT_ID: 'cloud-id', B24_CLIENT_SECRET: 'cloud-secret', B24_APP_CODE: 'local.cloud',
    B24_SPY_BOX_APP: `${BOX} box-id box-secret local.box`,
    B24_SELFHOSTED_HOSTS: BOX, B24_SPY_PORTALS: `b24-x.bitrix24.by, ${BOX}`,
    ...over
  })

  it('коробка из обоих списков — её реквизиты и код; облако — облачные', () => {
    expect(appForPortal('Stand.Example.BY', env())).toEqual({ creds: { clientId: 'box-id', clientSecret: 'box-secret' }, appCode: 'local.box' })
    expect(appForPortal('b24-x.bitrix24.by', env())).toEqual({ creds: { clientId: 'cloud-id', clientSecret: 'cloud-secret' }, appCode: 'local.cloud' })
  })

  it('хоста нет в B24_SELFHOSTED_HOSTS или в B24_SPY_PORTALS — реквизиты коробки не действуют', () => {
    expect(spyBoxApp(env({ B24_SELFHOSTED_HOSTS: '' }))).toBeNull()
    expect(spyBoxApp(env({ B24_SPY_PORTALS: 'b24-x.bitrix24.by' }))).toBeNull()
    expect(spyBoxState(env({ B24_SPY_PORTALS: '' }))).toMatchObject({ state: 'invalid', reason: 'host not in B24_SPY_PORTALS' })
  })

  it('мусор в B24_SPY_BOX_APP — не действует и помечен как ошибка (без значений)', () => {
    expect(spyBoxState(env({ B24_SPY_BOX_APP: '' }))).toEqual({ state: 'off' })
    for (const v of [BOX, `${BOX} id secret`, `${BOX} id secret code extra`]) {
      expect(spyBoxApp(env({ B24_SPY_BOX_APP: v }))).toBeNull()
      const st = spyBoxState(env({ B24_SPY_BOX_APP: v }))
      expect(st).toMatchObject({ state: 'invalid', host: BOX })
      expect(JSON.stringify(st)).not.toMatch(/secret/)
    }
  })

  it('хост со схемой и портом приводится как в списках', () => {
    expect(spyBoxApp(env({ B24_SPY_BOX_APP: `https://${BOX.toUpperCase()}:443 box-id box-secret local.box` }))?.host).toBe(BOX)
    expect(appForPortal(`${BOX}:443`, env()).creds.clientId).toBe('box-id')
  })

  it('задана с ошибкой — для хоста стенда пустые реквизиты, а не облачные; облако — как было', () => {
    const bad = env({ B24_SPY_BOX_APP: `${BOX} box-id box-secret` })
    expect(appForPortal(BOX, bad)).toEqual({ creds: { clientId: '', clientSecret: '' }, appCode: '' })
    expect(appForPortal('b24-x.bitrix24.by', bad).creds.clientId).toBe('cloud-id')
    const notListed = env({ B24_SPY_PORTALS: 'b24-x.bitrix24.by' })
    expect(appForPortal(BOX, notListed).creds.clientId).toBe('')
  })
})

describe('spyAppsState / appForPortal (B24_SPY_APPS: свои приложения облачных порталов)', () => {
  const RU = 'b24-y.bitrix24.ru'
  const BOX = 'stand.example.by'
  const env = (over: Record<string, string> = {}) => ({
    B24_CLIENT_ID: 'cloud-id', B24_CLIENT_SECRET: 'cloud-secret', B24_APP_CODE: 'local.cloud',
    B24_SPY_BOX_APP: `${BOX} box-id box-secret local.box`, B24_SELFHOSTED_HOSTS: BOX,
    B24_SPY_PORTALS: `b24-x.bitrix24.by, ${RU}, ${BOX}`,
    B24_SPY_APPS: ` ${RU} ru-id ru-secret local.ru ; `,
    ...over
  })

  it('строка портала — его реквизиты и код; облако по умолчанию и коробка — как было', () => {
    expect(appForPortal('B24-Y.Bitrix24.RU', env())).toEqual({ creds: { clientId: 'ru-id', clientSecret: 'ru-secret' }, appCode: 'local.ru' })
    expect(appForPortal('b24-x.bitrix24.by', env()).creds.clientId).toBe('cloud-id')
    expect(appForPortal(BOX, env()).creds.clientId).toBe('box-id')
    expect(spyAppsState(env({ B24_SPY_APPS: '' }))).toEqual({ apps: [], invalid: [] })
    expect(appForPortal(RU, env({ B24_SPY_APPS: '' })).creds.clientId).toBe('cloud-id')
  })

  it('несколько строк через «;»', () => {
    const st = spyAppsState(env({ B24_SPY_APPS: `${RU} ru-id ru-secret local.ru;b24-x.bitrix24.by by-id by-secret local.by` }))
    expect(st.apps.map(a => a.host)).toEqual([RU, 'b24-x.bitrix24.by'])
    expect(st.invalid).toEqual([])
  })

  it('хоста нет в B24_SPY_PORTALS или строка кривая — для хоста пустые реквизиты, ошибка без значений', () => {
    for (const over of [{ B24_SPY_PORTALS: 'b24-x.bitrix24.by' }, { B24_SPY_APPS: `${RU} ru-id ru-secret` }, { B24_SPY_APPS: `${RU} ru-id ru-secret local.ru extra` }] as Array<Record<string, string>>) {
      const st = spyAppsState(env(over))
      expect(st.apps).toEqual([])
      expect(st.invalid[0]?.host).toBe(RU)
      expect(JSON.stringify(st)).not.toMatch(/secret|ru-id/)
      expect(appForPortal(RU, env(over))).toEqual({ creds: { clientId: '', clientSecret: '' }, appCode: '' })
    }
    expect(appForPortal('b24-x.bitrix24.by', env({ B24_SPY_APPS: `${RU} ru-id` })).creds.clientId).toBe('cloud-id')
  })

  it('один хост дважды — не действует ни одна строка', () => {
    const twice = env({ B24_SPY_APPS: `${RU} a-id a-secret local.a;${RU} b-id b-secret local.b` })
    expect(spyAppsState(twice)).toEqual({ apps: [], invalid: [{ host: RU, reason: 'host listed twice' }] })
    expect(appForPortal(RU, twice).creds.clientId).toBe('')
  })
})
