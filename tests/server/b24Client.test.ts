import { describe, expect, it } from 'vitest'
import { appForPortal, oauthCredsFromEnv, envTokenFor, ownSpyApp, spyAppsHealth, spyAppsState, spyBoxApp, spyBoxState, oauthParams, restCallFrom, type SdkCallClient } from '../../server/utils/b24Client'

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

describe('B24_SPY_APPS: свои приложения шпиона на облачных порталах', () => {
  const RU = 'b24-y.bitrix24.ru'
  const BY = 'b24-x.bitrix24.by'
  const BOX = 'stand.example.by'
  const env = (over: Record<string, string> = {}): Record<string, string> => ({
    B24_CLIENT_ID: 'cloud-id', B24_CLIENT_SECRET: 'cloud-secret', B24_APP_CODE: 'local.cloud', B24_APPLICATION_TOKEN: 'shared-token',
    B24_SPY_BOX_APP: `${BOX} box-id box-secret local.box`, B24_SELFHOSTED_HOSTS: BOX,
    B24_SPY_PORTALS: `${BY}, ${RU}, ${BOX}`,
    B24_SPY_APPS: ` ${RU} ru-id ru-secret local.ru ; `,
    ...over
  })
  const cloud = { creds: { clientId: 'cloud-id', clientSecret: 'cloud-secret' }, appCode: 'local.cloud' }
  const empty = { creds: { clientId: '', clientSecret: '' }, appCode: '' }

  it('строка портала — его реквизиты и код; облако и коробка — как было; пусто — облако', () => {
    expect(appForPortal('B24-Y.Bitrix24.RU', env())).toEqual({ creds: { clientId: 'ru-id', clientSecret: 'ru-secret' }, appCode: 'local.ru' })
    expect(appForPortal(BY, env())).toEqual(cloud)
    expect(appForPortal(BOX, env()).creds.clientId).toBe('box-id')
    expect(spyAppsState(env({ B24_SPY_APPS: '' }))).toEqual({ apps: [], invalid: [], ignored: [] })
    expect(appForPortal(RU, env({ B24_SPY_APPS: '' }))).toEqual(cloud)
  })

  it('несколько строк через «;», табы и двойные пробелы внутри строки', () => {
    const st = spyAppsState(env({ B24_SPY_APPS: `${RU}\tru-id  ru-secret local.ru;;${BY} by-id by-secret local.by` }))
    expect(st.apps.map(a => [a.host, a.creds.clientId])).toEqual([[RU, 'ru-id'], [BY, 'by-id']])
    expect([st.invalid, st.ignored]).toEqual([[], []])
  })

  it('кривая строка нашего портала — хост заблокирован (503), причина точная, без значений', () => {
    const cases: Array<[string, string]> = [[`${RU} ru-id ru-secret`, 'expected 4 fields, got 3'], [`${RU} ru-id ru-secret local.ru extra`, 'expected 4 fields, got 5']]
    for (const [line, reason] of cases) {
      const st = spyAppsState(env({ B24_SPY_APPS: line }))
      expect(st).toEqual({ apps: [], invalid: [{ host: RU, reason }], ignored: [] })
      expect(JSON.stringify(st)).not.toMatch(/secret|ru-id/)
      expect(appForPortal(RU, env({ B24_SPY_APPS: line }))).toEqual(empty)
    }
    expect(appForPortal(BY, env({ B24_SPY_APPS: `${RU} ru-id` }))).toEqual(cloud)
  })

  it('хост не из B24_SPY_PORTALS — строка без влияния: портал на облачных реквизитах и общем токене', () => {
    const e = env({ B24_SPY_APPS: 'client.bitrix24.ru c-id c-secret local.c' })
    expect(spyAppsState(e)).toEqual({ apps: [], invalid: [], ignored: [{ host: 'client.bitrix24.ru', reason: 'host not in B24_SPY_PORTALS' }] })
    expect(appForPortal('client.bitrix24.ru', e)).toEqual(cloud)
    expect(ownSpyApp('client.bitrix24.ru', e)).toBe(false)
    expect(envTokenFor('client.bitrix24.ru', e)).toBe('shared-token')
  })

  it('хост коробки в B24_SPY_APPS — строка без влияния, коробка работает', () => {
    const e = env({ B24_SPY_APPS: `${BOX} x-id x-secret local.x` })
    expect(spyAppsState(e).ignored).toEqual([{ host: BOX, reason: 'host is the spy box (B24_SPY_BOX_APP)' }])
    expect(appForPortal(BOX, e).creds.clientId).toBe('box-id')
    const badBox = env({ B24_SPY_BOX_APP: `${BOX} box-id box-secret`, B24_SPY_APPS: `${BOX} x-id x-secret local.x` })
    expect(spyAppsState(badBox).ignored[0]?.reason).toBe('host is the spy box (B24_SPY_BOX_APP)')
    expect(ownSpyApp(BOX, badBox)).toBe(true)
    expect(appForPortal(BOX, badBox)).toEqual(empty)
  })

  it('хост дважды (и одна строка кривая) — одна запись «listed twice», ни одна строка не действует', () => {
    for (const v of [`${RU} a-id a-secret local.a;${RU} b-id b-secret local.b`, `${RU} a-id a-secret local.a;${RU} b-id b-secret`, `${RU} a;${RU} b`]) {
      const st = spyAppsState(env({ B24_SPY_APPS: v }))
      expect(st).toEqual({ apps: [], invalid: [{ host: RU, reason: 'host listed twice' }], ignored: [] })
      expect(appForPortal(RU, env({ B24_SPY_APPS: v }))).toEqual(empty)
    }
  })

  it('поле без точки (сдвинутый секрет, client_id без хоста) — в отчёт не попадает, хост не блокирует', () => {
    const e = env({ B24_SPY_APPS: `${RU} ru-id;S3cretValue local.ru;S3cret2 a b c` })
    const st = spyAppsState(e)
    expect(JSON.stringify(st)).not.toMatch(/S3cret/i)
    expect(st.ignored).toEqual([{ host: '', reason: 'expected 4 fields, got 2' }, { host: '', reason: 'host is not a hostname' }])
    expect(st.invalid).toEqual([{ host: RU, reason: 'expected 4 fields, got 2' }])
    expect(appForPortal('', e)).toEqual(cloud)
  })

  it('регистр и схема — и в строке, и в домене запроса', () => {
    const e = env({ B24_SPY_APPS: 'https://B24-Y.Bitrix24.RU ru-id ru-secret local.ru', B24_SPY_PORTALS: 'B24-Y.BITRIX24.RU' })
    expect(spyAppsState(e).apps[0]?.host).toBe(RU)
    expect(ownSpyApp('https://B24-Y.Bitrix24.RU', e)).toBe(true)
  })

  it('envTokenFor: свои приложения (и с ошибкой) — без общего токена; облако — общий', () => {
    expect(envTokenFor(RU, env())).toBe('')
    expect(envTokenFor(BOX, env())).toBe('')
    expect(envTokenFor(RU, env({ B24_SPY_APPS: `${RU} ru-id` }))).toBe('')
    expect(envTokenFor(BY, env())).toBe('shared-token')
    expect(envTokenFor('', env())).toBe('shared-token')
    expect(envTokenFor(BY, env({ B24_APPLICATION_TOKEN: '' }))).toBe('')
  })

  it('health: счётчики без хостов и значений', () => {
    const e = env({ B24_SPY_APPS: `${RU} ru-id ru-secret local.ru;${BY} by-id;client.bitrix24.ru c d e` })
    expect(spyAppsHealth(e)).toEqual({ on: 1, invalid: 1, ignored: 1 })
    expect(JSON.stringify(spyAppsHealth(e))).not.toMatch(/bitrix24|secret|-id/)
  })
})
