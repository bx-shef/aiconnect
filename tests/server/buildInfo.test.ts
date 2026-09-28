import { describe, expect, it } from 'vitest'
import { buildCommit } from '../../server/utils/buildInfo'

describe('buildCommit — коммит сборки для /api/health', () => {
  const SHA = 'a8f2ef2b57059e518ff1f14a880dcee79dd41d00'

  it('отдаёт 7 знаков коммита, который CI зашил в образ, — как в теге sha-… для отката', () => {
    expect(buildCommit(SHA)).toBe('a8f2ef2')
  })

  it('пробелы по краям и верхний регистр не мешают', () => {
    expect(buildCommit(` ${SHA.toUpperCase()}\n`)).toBe('a8f2ef2')
  })

  it('локальная сборка без COMMIT_SHA — null', () => {
    expect(buildCommit(undefined)).toBeNull()
    expect(buildCommit('')).toBeNull()
  })

  it('не полный SHA — null: health открыт без входа, произвольный текст наружу не уходит', () => {
    expect(buildCommit(SHA.slice(0, 7))).toBeNull()
    expect(buildCommit(`${SHA}0`)).toBeNull()
    expect(buildCommit(`${SHA.slice(0, 39)}g`)).toBeNull()
    expect(buildCommit('secret-token-by-mistake')).toBeNull()
    expect(buildCommit(`${SHA}\n${SHA}`)).toBeNull()
  })
})
