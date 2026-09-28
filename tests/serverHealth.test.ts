import { describe, expect, it } from 'vitest'
import { serverProblems } from '~/utils/serverHealth'

describe('serverProblems', () => {
  it('всё задано — пусто', () => {
    expect(serverProblems({ ok: true, config: { appCode: true, oauth: true, tokenKey: true, bitrixGpt: true } })).toEqual([])
  })

  it('нет кода приложения — блокирующая проблема с именем переменной', () => {
    expect(serverProblems({ config: { appCode: false, oauth: true, tokenKey: true, bitrixGpt: true } }))
      .toEqual([{ variable: 'B24_APP_CODE', effect: expect.stringMatching(/отклоняет/), blocking: true }])
  })

  it('без OAuth-реквизитов или ключа шифрования — блокирующие проблемы с именами переменных', () => {
    const all = { appCode: true, oauth: true, tokenKey: true, bitrixGpt: true }
    expect(serverProblems({ config: { ...all, oauth: false } })).toEqual([{ variable: 'B24_CLIENT_ID, B24_CLIENT_SECRET', effect: expect.stringMatching(/установка не сохраняется/), blocking: true }])
    expect(serverProblems({ config: { ...all, tokenKey: false } })).toEqual([{ variable: 'B24_TOKEN_ENC_KEY', effect: expect.stringMatching(/установка не сохраняется/), blocking: true }])
  })

  it('без ключа BitrixGPT — проблема, но не блокирующая', () => {
    expect(serverProblems({ config: { appCode: true, oauth: true, tokenKey: true, bitrixGpt: false } })[0]?.blocking).toBe(false)
  })

  it('непонятный ответ — без выводов (не пугаем администратора зря)', () => {
    expect(serverProblems(null)).toEqual([])
    expect(serverProblems({ config: 'x' })).toEqual([])
    expect(serverProblems({ config: { appCode: 'yes' } })).toEqual([])
  })
})
