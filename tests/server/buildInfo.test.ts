import { describe, expect, it } from 'vitest'
import { buildCommit } from '../../server/utils/buildInfo'

describe('buildCommit — build commit for /api/health', () => {
  const SHA = 'a8f2ef2b57059e518ff1f14a880dcee79dd41d00'

  it('returns the 7-char commit CI baked into the image — matching the sha-… tag used for rollback', () => {
    expect(buildCommit(SHA)).toBe('a8f2ef2')
  })

  it('surrounding whitespace and uppercase do not matter', () => {
    expect(buildCommit(` ${SHA.toUpperCase()}\n`)).toBe('a8f2ef2')
  })

  it('local build without COMMIT_SHA — null', () => {
    expect(buildCommit(undefined)).toBeNull()
    expect(buildCommit('')).toBeNull()
  })

  it('not a full SHA — null: health is open with no auth, so arbitrary text must not leak out', () => {
    expect(buildCommit(SHA.slice(0, 7))).toBeNull()
    expect(buildCommit(`${SHA}0`)).toBeNull()
    expect(buildCommit(`${SHA.slice(0, 39)}g`)).toBeNull()
    expect(buildCommit('secret-token-by-mistake')).toBeNull()
    expect(buildCommit(`${SHA}\n${SHA}`)).toBeNull()
  })
})
