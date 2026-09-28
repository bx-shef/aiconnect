import { describe, expect, it } from 'vitest'
import { assertTestPortal, parseSmokeEnv, readEnvValue, TEST_PORTALS } from '../smoke/lib/env'

describe('smoke: чтение файла окружения', () => {
  it('последнее вхождение, кавычки, export; комментарий и ключ-суффикс не считаются', () => {
    const text = [
      'B24_HOOK=https://old.bitrix24.by/rest/1/a/',
      '#B24_HOOK=https://commented.bitrix24.by/rest/1/b/',
      'OLD_B24_HOOK=https://suffix.bitrix24.by/rest/1/c/',
      'export B24_HOOK="https://new.bitrix24.by/rest/1/d/"'
    ].join('\n')
    expect(readEnvValue(text, 'B24_HOOK')).toBe('https://new.bitrix24.by/rest/1/d/')
    expect(readEnvValue('', 'B24_HOOK')).toBe('')
  })

  it('пустое значение последней строкой перебивает прежнее (семантика dotenv)', () => {
    expect(readEnvValue('B24_HOOK=https://a.bitrix24.by/rest/1/a/\nB24_HOOK=', 'B24_HOOK')).toBe('')
  })

  it('закомментированная или чужая строка ПОСЛЕ нужной не перебивает её', () => {
    const text = 'B24_HOOK=https://test.bitrix24.by/rest/1/a/\n#B24_HOOK=https://prod.bitrix24.ru/rest/1/b/\nOLD_B24_HOOK=https://old.bitrix24.ru/rest/1/c/'
    expect(readEnvValue(text, 'B24_HOOK')).toBe('https://test.bitrix24.by/rest/1/a/')
  })

  it('нет вебхука — null (смок пропускается); не https — ошибка без адреса в тексте', () => {
    expect(parseSmokeEnv('VIBE_API_KEY=x')).toBeNull()
    expect(() => parseSmokeEnv('B24_HOOK=http://p.bitrix24.by/rest/1/secret/')).toThrow(/не https/)
    expect(() => parseSmokeEnv('B24_HOOK=http://p.bitrix24.by/rest/1/secret/')).not.toThrow(/secret/)
  })

  it('ключ BitrixGPT: только из файла (BITRIXGPT_API_KEY, затем VIBE_API_KEY); хост — в нижнем регистре', () => {
    const env = parseSmokeEnv('B24_HOOK=https://P.Bitrix24.by/rest/1/x/\nVIBE_API_KEY=vibe_file')
    expect(env).toEqual({ hook: 'https://P.Bitrix24.by/rest/1/x/', host: 'p.bitrix24.by', aiKey: 'vibe_file' })
    expect(parseSmokeEnv('B24_HOOK=https://p.bitrix24.by/rest/1/x/\nVIBE_API_KEY=v\nBITRIXGPT_API_KEY=b')?.aiKey).toBe('b')
    expect(parseSmokeEnv('B24_HOOK=https://p.bitrix24.by/rest/1/x/')?.aiKey).toBe('')
  })
})

describe('smoke: страж тестового портала', () => {
  it('портал из списка — можно; чужой — отказ; чужой с явным согласием на ЭТОТ домен — можно', () => {
    const [known] = [...TEST_PORTALS]
    expect(() => assertTestPortal(known!)).not.toThrow()
    expect(() => assertTestPortal('client.bitrix24.ru')).toThrow(/не в списке тестовых/)
    expect(() => assertTestPortal('client.bitrix24.ru', 'other.bitrix24.ru')).toThrow()
    expect(() => assertTestPortal('client.bitrix24.ru', ' Client.Bitrix24.ru ')).not.toThrow()
  })
})
