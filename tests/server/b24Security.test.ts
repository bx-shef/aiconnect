import { describe, expect, it } from 'vitest'
import { assertPortalHost, DEFAULT_OAUTH_HOST, frameAncestors, isAllowedPortalHost, parseSelfHostedHosts, portalHostname, resolveOAuthHost } from '../../server/utils/b24Host'
import { appTokenVerdict, parseBracketForm, parseEventAuth, safeEqual } from '../../server/utils/b24Events'

describe('SSRF-гард адреса портала', () => {
  it('пропускает облачные порталы в любой зоне', () => {
    expect(isAllowedPortalHost('demo.bitrix24.ru')).toBe(true)
    expect(isAllowedPortalHost('https://demo.bitrix24.com.br/')).toBe(true)
  })

  it('не пускает похожие домены и трюки с userinfo', () => {
    expect(isAllowedPortalHost('evil-bitrix24.ru')).toBe(false)
    expect(isAllowedPortalHost('demo.bitrix24.ru.attacker.com')).toBe(false)
    expect(portalHostname('demo.bitrix24.ru@evil.com')).toBe('evil.com')
    expect(isAllowedPortalHost('demo.bitrix24.ru@evil.com')).toBe(false)
    expect(isAllowedPortalHost('')).toBe(false)
  })

  it('коробочный портал — только из явного списка', () => {
    const hosts = parseSelfHostedHosts('https://crm.company.by/, portal.local')
    expect(isAllowedPortalHost('crm.company.by', hosts)).toBe(true)
    expect(isAllowedPortalHost('other.company.by', hosts)).toBe(false)
  })

  it('assertPortalHost возвращает чистый хост и бросает на чужом', () => {
    expect(assertPortalHost('https://Demo.Bitrix24.ru/rest/', {})).toBe('demo.bitrix24.ru')
    expect(() => assertPortalHost('evil.com', {})).toThrow(/not allow-listed/)
  })
})

describe('разбор тела события', () => {
  it('восстанавливает вложенность из скобочной формы', () => {
    expect(parseBracketForm('event=ONAPPINSTALL&auth[member_id]=abc&data[VERSION]=1')).toEqual({
      event: 'ONAPPINSTALL', auth: { member_id: 'abc' }, data: { VERSION: '1' }
    })
  })

  it('не даёт отравить прототип', () => {
    parseBracketForm('__proto__[polluted]=1&auth[constructor][x]=1')
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
  })

  it('auth без домена, member_id или токена — ошибка', () => {
    expect(() => parseEventAuth({ auth: { domain: 'x.bitrix24.ru', member_id: 'm' } })).toThrow()
    expect(parseEventAuth({ auth: { domain: 'x.bitrix24.ru', member_id: 'm', application_token: 't' } }).expiresIn).toBe(3600)
  })
})

describe('проверка application_token', () => {
  it('установка: без токена в окружении первый непустой принимается, пустой — нет', () => {
    expect(appTokenVerdict({ isInstall: true, incoming: 't' })).toBe('accept')
    expect(appTokenVerdict({ isInstall: true, incoming: '' })).toBe('forbidden')
    expect(appTokenVerdict({ isInstall: true, incoming: 't', envToken: 'other' })).toBe('forbidden')
  })

  it('удаление: без ожидаемого токена — unconfigured, а не «поверим»', () => {
    expect(appTokenVerdict({ isInstall: false, incoming: 't' })).toBe('unconfigured')
    expect(appTokenVerdict({ isInstall: false, incoming: 't', storedToken: 't' })).toBe('accept')
    expect(appTokenVerdict({ isInstall: false, incoming: 'x', storedToken: 't' })).toBe('forbidden')
  })

  it('safeEqual сравнивает строки разной длины без исключений', () => {
    expect(safeEqual('abc', 'abc')).toBe(true)
    expect(safeEqual('abc', 'abcd')).toBe(false)
  })
})

describe('CSP для фрейма', () => {
  it('разрешает встраивание только порталам Битрикс24 и перечисленным коробкам', () => {
    const csp = frameAncestors('crm.company.by')
    expect(csp.startsWith('frame-ancestors \'self\' ')).toBe(true)
    expect(csp).toContain('https://*.bitrix24.ru')
    expect(csp).toContain('https://crm.company.by')
    expect(csp).not.toContain('*.com ')
  })
})

describe('сервер авторизации установки (auth[server_endpoint])', () => {
  it('облачные — из списка, в любом виде адреса', () => {
    expect(resolveOAuthHost('https://oauth.bitrix24.tech/rest/')).toBe('oauth.bitrix24.tech')
    expect(resolveOAuthHost('http://oauth.bitrix.info/rest/')).toBe('oauth.bitrix.info')
  })

  it('поля нет — сервер по умолчанию', () => {
    expect(resolveOAuthHost('')).toBe(DEFAULT_OAUTH_HOST)
    expect(resolveOAuthHost('  ')).toBe(DEFAULT_OAUTH_HOST)
  })

  it('чужой хост, трюк с userinfo, похожее имя, портал — null (SSRF и подделка гранта)', () => {
    for (const ep of ['https://evil.com/rest/', 'https://oauth.bitrix24.tech@evil.com/rest/', 'https://oauth.bitrix24.tech.evil.com/', 'https://x.bitrix24.ru/rest/', 'не адрес']) {
      expect(resolveOAuthHost(ep), ep).toBeNull()
    }
  })

  it('коробка сервером авторизации не бывает — даже своей установки и даже из списка коробок', () => {
    // Иначе владелец коробки «выдал» бы грант с member_id облачного портала-жертвы.
    expect(resolveOAuthHost('https://crm.company.by/rest/')).toBeNull()
  })
})
