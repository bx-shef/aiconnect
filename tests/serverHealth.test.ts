import { describe, expect, it } from 'vitest'
import { serverProblems } from '~/utils/serverHealth'

describe('serverProblems', () => {
  const all = { appCode: true, oauth: true, tokenKey: true }

  it('everything set — empty', () => {
    expect(serverProblems({ ok: true, config: all })).toEqual([])
  })

  it('no app code — blocking problem with the variable name', () => {
    expect(serverProblems({ config: { ...all, appCode: false } }))
      .toEqual([{ variable: 'B24_APP_CODE', effect: expect.stringMatching(/отклоняет/), blocking: true }])
  })

  it('no OAuth credentials or encryption key — blocking problems with the variable names', () => {
    expect(serverProblems({ config: { ...all, oauth: false } })).toEqual([{ variable: 'B24_CLIENT_ID, B24_CLIENT_SECRET', effect: expect.stringMatching(/установка не сохраняется/), blocking: true }])
    expect(serverProblems({ config: { ...all, tokenKey: false } })).toEqual([{ variable: 'B24_TOKEN_ENC_KEY', effect: expect.stringMatching(/установка не сохраняется/), blocking: true }])
  })

  it('an unrecognized response — no findings (do not alarm the admin for nothing)', () => {
    expect(serverProblems(null)).toEqual([])
    expect(serverProblems({ config: 'x' })).toEqual([])
    expect(serverProblems({ config: { appCode: 'yes' } })).toEqual([])
  })
})
