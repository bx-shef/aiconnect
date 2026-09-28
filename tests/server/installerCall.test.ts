import { randomBytes } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makeInstallerCall, withKeyLock } from '../../server/utils/installerCall'
import { accessTokenOf, saveInstall, updateTokens, type KeyValue, type PortalRecord } from '../../server/utils/tokenStore'

function memoryKv(): KeyValue {
  const data = new Map<string, unknown>()
  return {
    getItem: async key => data.get(key) ?? null,
    setItem: async (key, value) => void data.set(key, value),
    removeItem: async key => void data.delete(key)
  }
}

beforeEach(() => {
  vi.stubEnv('B24_TOKEN_ENC_KEY', randomBytes(32).toString('hex'))
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('withKeyLock', () => {
  it('вызовы с одним ключом — по очереди, с разными — параллельно', async () => {
    const order: string[] = []
    const slow = (name: string, ms: number) => async () => {
      order.push(`${name}:start`)
      await new Promise(r => setTimeout(r, ms))
      order.push(`${name}:end`)
    }
    await Promise.all([withKeyLock('a', slow('a1', 20)), withKeyLock('a', slow('a2', 1)), withKeyLock('b', slow('b1', 1))])
    expect(order.indexOf('a2:start')).toBeGreaterThan(order.indexOf('a1:end'))
    expect(order.indexOf('b1:start')).toBeLessThan(order.indexOf('a1:end'))
  })

  it('зависший вызов отклоняется по таймауту, и очередь идёт дальше', async () => {
    const hung = withKeyLock('h', () => new Promise<never>(() => {}), 20)
    const next = withKeyLock('h', async () => 'next', 20)
    await expect(hung).rejects.toThrow(/timed out/)
    expect(await next).toBe('next')
  })

  it('ошибка одного вызова не блокирует очередь', async () => {
    await expect(withKeyLock('k', async () => {
      throw new Error('boom')
    })).rejects.toThrow('boom')
    expect(await withKeyLock('k', async () => 'next')).toBe('next')
  })
})

describe('makeInstallerCall', () => {
  it('каждый вызов — по СВЕЖЕЙ записи: после рефреша второй вызов видит новые токены', async () => {
    const kv = memoryKv()
    await saveInstall(kv, { memberId: 'm1', domain: 'demo.bitrix24.ru', accessToken: 'A1', refreshToken: 'R1', expiresIn: 3600, applicationToken: 't' })
    const seen: string[] = []
    const call = makeInstallerCall({
      kv,
      memberId: 'm1',
      clientFor: (record: PortalRecord) => async () => {
        seen.push(accessTokenOf(record))
        // Имитация рефреша внутри SDK: токены ротируются и сохраняются.
        await updateTokens(kv, 'm1', { accessToken: `${accessTokenOf(record)}+`, refreshToken: 'R2', expiresAt: 1 })
        return true
      }
    })
    await call('app.option.set')
    await call('app.option.set')
    expect(seen).toEqual(['A1', 'A1+'])
  })

  it('одновременные вызовы не рефрешат одним токеном: второй ждёт первый', async () => {
    const kv = memoryKv()
    await saveInstall(kv, { memberId: 'm1', domain: 'demo.bitrix24.ru', accessToken: 'A1', refreshToken: 'R1', expiresIn: 3600, applicationToken: 't' })
    const seen: string[] = []
    const call = makeInstallerCall({
      kv,
      memberId: 'm1',
      clientFor: record => async () => {
        seen.push(accessTokenOf(record))
        await new Promise(r => setTimeout(r, 5))
        await updateTokens(kv, 'm1', { accessToken: `${accessTokenOf(record)}+`, refreshToken: 'R2', expiresAt: 1 })
      }
    })
    await Promise.all([call('a'), call('b')])
    expect(seen).toEqual(['A1', 'A1+'])
  })

  it('один портал — одна очередь, как бы ни был записан member_id', async () => {
    const kv = memoryKv()
    await saveInstall(kv, { memberId: 'm1', domain: 'demo.bitrix24.ru', accessToken: 'A1', refreshToken: 'R1', expiresIn: 3600, applicationToken: 't' })
    const seen: string[] = []
    const clientFor = (record: PortalRecord) => async () => {
      seen.push(accessTokenOf(record))
      await new Promise(r => setTimeout(r, 5))
      await updateTokens(kv, 'm1', { accessToken: `${accessTokenOf(record)}+`, refreshToken: 'R2', expiresAt: 1 })
    }
    await Promise.all([makeInstallerCall({ kv, memberId: 'M1', clientFor })('a'), makeInstallerCall({ kv, memberId: 'm1', clientFor })('b')])
    expect(seen).toEqual(['A1', 'A1+'])
  })

  it('портал удалён — понятная ошибка, а не вызов с пустыми токенами', async () => {
    const clientFor = vi.fn()
    await expect(makeInstallerCall({ kv: memoryKv(), memberId: 'gone', clientFor })('x')).rejects.toThrow('portal not installed')
    expect(clientFor).not.toHaveBeenCalled()
  })
})
