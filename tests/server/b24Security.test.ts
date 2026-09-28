import { describe, expect, it } from 'vitest'
import { assertPortalHost, DEFAULT_OAUTH_HOST, frameAncestors, isAllowedPortalHost, parseSelfHostedHosts, portalHostname, resolveOAuthHost } from '../../server/utils/b24Host'
import { appTokenVerdict, parseBracketForm, parseEventAuth, safeEqual } from '../../server/utils/b24Events'

describe('SSRF guard for the portal address', () => {
  it('allows cloud portals in any zone', () => {
    expect(isAllowedPortalHost('demo.bitrix24.ru')).toBe(true)
    expect(isAllowedPortalHost('https://demo.bitrix24.com.br/')).toBe(true)
  })

  it('blocks lookalike domains and userinfo tricks', () => {
    expect(isAllowedPortalHost('evil-bitrix24.ru')).toBe(false)
    expect(isAllowedPortalHost('demo.bitrix24.ru.attacker.com')).toBe(false)
    expect(portalHostname('demo.bitrix24.ru@evil.com')).toBe('evil.com')
    expect(isAllowedPortalHost('demo.bitrix24.ru@evil.com')).toBe(false)
    expect(isAllowedPortalHost('')).toBe(false)
  })

  it('self-hosted portal — only from the explicit list', () => {
    const hosts = parseSelfHostedHosts('https://crm.company.by/, portal.local')
    expect(isAllowedPortalHost('crm.company.by', hosts)).toBe(true)
    expect(isAllowedPortalHost('other.company.by', hosts)).toBe(false)
  })

  it('assertPortalHost returns the clean host and throws on a disallowed one', () => {
    expect(assertPortalHost('https://Demo.Bitrix24.ru/rest/', {})).toBe('demo.bitrix24.ru')
    expect(() => assertPortalHost('evil.com', {})).toThrow(/not allow-listed/)
  })
})

describe('event body parsing', () => {
  it('rebuilds nesting from the bracket form', () => {
    expect(parseBracketForm('event=ONAPPINSTALL&auth[member_id]=abc&data[VERSION]=1')).toEqual({
      event: 'ONAPPINSTALL', auth: { member_id: 'abc' }, data: { VERSION: '1' }
    })
  })

  it('does not allow prototype pollution', () => {
    parseBracketForm('__proto__[polluted]=1&auth[constructor][x]=1')
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
  })

  it('auth without domain, member_id or token — throws', () => {
    expect(() => parseEventAuth({ auth: { domain: 'x.bitrix24.ru', member_id: 'm' } })).toThrow()
    expect(parseEventAuth({ auth: { domain: 'x.bitrix24.ru', member_id: 'm', application_token: 't' } }).expiresIn).toBe(3600)
  })
})

describe('application_token check', () => {
  it('install: with no token in the environment, the first non-empty one is accepted, an empty one is not', () => {
    expect(appTokenVerdict({ isInstall: true, incoming: 't' })).toBe('accept')
    expect(appTokenVerdict({ isInstall: true, incoming: '' })).toBe('forbidden')
    expect(appTokenVerdict({ isInstall: true, incoming: 't', envToken: 'other' })).toBe('forbidden')
  })

  it('uninstall: no expected token — unconfigured, not "take it on faith"', () => {
    expect(appTokenVerdict({ isInstall: false, incoming: 't' })).toBe('unconfigured')
    expect(appTokenVerdict({ isInstall: false, incoming: 't', storedToken: 't' })).toBe('accept')
    expect(appTokenVerdict({ isInstall: false, incoming: 'x', storedToken: 't' })).toBe('forbidden')
  })

  it('safeEqual compares strings of different length without throwing', () => {
    expect(safeEqual('abc', 'abc')).toBe(true)
    expect(safeEqual('abc', 'abcd')).toBe(false)
  })
})

describe('frame CSP', () => {
  it('allows embedding only for Bitrix24 portals and the listed self-hosted instances', () => {
    const csp = frameAncestors('crm.company.by')
    expect(csp.startsWith('frame-ancestors \'self\' ')).toBe(true)
    expect(csp).toContain('https://*.bitrix24.ru')
    expect(csp).toContain('https://crm.company.by')
    expect(csp).not.toContain('*.com ')
  })
})

describe('install auth server (auth[server_endpoint])', () => {
  it('cloud — from the list, in any address form', () => {
    expect(resolveOAuthHost('https://oauth.bitrix24.tech/rest/')).toBe('oauth.bitrix24.tech')
    expect(resolveOAuthHost('http://oauth.bitrix.info/rest/')).toBe('oauth.bitrix.info')
  })

  it('field absent — default server', () => {
    expect(resolveOAuthHost('')).toBe(DEFAULT_OAUTH_HOST)
    expect(resolveOAuthHost('  ')).toBe(DEFAULT_OAUTH_HOST)
  })

  it('disallowed host, userinfo trick, lookalike name, portal — null (SSRF and grant forgery)', () => {
    for (const ep of ['https://evil.com/rest/', 'https://oauth.bitrix24.tech@evil.com/rest/', 'https://oauth.bitrix24.tech.evil.com/', 'https://x.bitrix24.ru/rest/', 'not an address']) {
      expect(resolveOAuthHost(ep), ep).toBeNull()
    }
  })

  it('a self-hosted instance is never an auth server — even for its own install and even from the self-hosted list', () => {
    // Otherwise the self-hosted owner could "issue" a grant with the member_id of a victim cloud portal.
    expect(resolveOAuthHost('https://crm.company.by/rest/')).toBeNull()
  })
})
