import { describe, expect, it } from 'vitest'
import { serverProblems } from '~/utils/serverHealth'

describe('serverProblems', () => {
  const all = { appCode: true, oauth: true, tokenKey: true }

  it('всё задано — пусто', () => {
    expect(serverProblems({ ok: true, config: all })).toEqual([])
  })

  it('нет кода приложения — блокирующая проблема с именем переменной', () => {
    expect(serverProblems({ config: { ...all, appCode: false } }))
      .toEqual([{ variable: 'B24_APP_CODE', effect: expect.stringMatching(/отклоняет/), blocking: true }])
  })

  it('без OAuth-реквизитов или ключа шифрования — блокирующие проблемы с именами переменных', () => {
    expect(serverProblems({ config: { ...all, oauth: false } })).toEqual([{ variable: 'B24_CLIENT_ID, B24_CLIENT_SECRET', effect: expect.stringMatching(/установка не сохраняется/), blocking: true }])
    expect(serverProblems({ config: { ...all, tokenKey: false } })).toEqual([{ variable: 'B24_TOKEN_ENC_KEY', effect: expect.stringMatching(/установка не сохраняется/), blocking: true }])
  })

  it('непонятный ответ — без выводов (не пугаем администратора зря)', () => {
    expect(serverProblems(null)).toEqual([])
    expect(serverProblems({ config: 'x' })).toEqual([])
    expect(serverProblems({ config: { appCode: 'yes' } })).toEqual([])
  })
})
