import { describe, expect, it } from 'vitest'
import { assertTestPortal, parseSmokeEnv, readEnvValue, TEST_PORTALS } from '../smoke/lib/env'

describe('smoke: reading the env file', () => {
  it('last occurrence, quotes, export; a comment or a suffixed key do not count', () => {
    const text = [
      'B24_HOOK=https://old.bitrix24.by/rest/1/a/',
      '#B24_HOOK=https://commented.bitrix24.by/rest/1/b/',
      'OLD_B24_HOOK=https://suffix.bitrix24.by/rest/1/c/',
      'export B24_HOOK="https://new.bitrix24.by/rest/1/d/"'
    ].join('\n')
    expect(readEnvValue(text, 'B24_HOOK')).toBe('https://new.bitrix24.by/rest/1/d/')
    expect(readEnvValue('', 'B24_HOOK')).toBe('')
  })

  it('an empty value on the last line overrides the previous one (dotenv semantics)', () => {
    expect(readEnvValue('B24_HOOK=https://a.bitrix24.by/rest/1/a/\nB24_HOOK=', 'B24_HOOK')).toBe('')
  })

  it('a commented-out or unrelated line AFTER the target one does not override it', () => {
    const text = 'B24_HOOK=https://test.bitrix24.by/rest/1/a/\n#B24_HOOK=https://prod.bitrix24.ru/rest/1/b/\nOLD_B24_HOOK=https://old.bitrix24.ru/rest/1/c/'
    expect(readEnvValue(text, 'B24_HOOK')).toBe('https://test.bitrix24.by/rest/1/a/')
  })

  it('no webhook — null (smoke test is skipped); not https — error without the address in the text', () => {
    expect(parseSmokeEnv('OTHER=x')).toBeNull()
    expect(() => parseSmokeEnv('B24_HOOK=http://p.bitrix24.by/rest/1/secret/')).toThrow(/не https/)
    expect(() => parseSmokeEnv('B24_HOOK=http://p.bitrix24.by/rest/1/secret/')).not.toThrow(/secret/)
  })

  it('host is lowercased, webhook address is kept as-is', () => {
    expect(parseSmokeEnv('B24_HOOK=https://P.Bitrix24.by/rest/1/x/')).toEqual({ hook: 'https://P.Bitrix24.by/rest/1/x/', host: 'p.bitrix24.by' })
  })
})

describe('smoke: test portal guard', () => {
  it('a listed portal is allowed; an unrelated one is refused; an unrelated one with explicit consent for THAT domain is allowed', () => {
    const [known] = [...TEST_PORTALS]
    expect(() => assertTestPortal(known!)).not.toThrow()
    expect(() => assertTestPortal('client.bitrix24.ru')).toThrow(/не в списке тестовых/)
    expect(() => assertTestPortal('client.bitrix24.ru', 'other.bitrix24.ru')).toThrow()
    expect(() => assertTestPortal('client.bitrix24.ru', ' Client.Bitrix24.ru ')).not.toThrow()
  })
})
