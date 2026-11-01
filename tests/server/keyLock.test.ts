import { describe, expect, it } from 'vitest'
import { withKeyLock } from '../../server/utils/keyLock'

const tick = (ms: number) => new Promise(r => setTimeout(r, ms))

describe('withKeyLock', () => {
  it('runs tasks of one key one after another, in call order', async () => {
    const log: string[] = []
    await Promise.all([
      withKeyLock('k', async () => {
        log.push('a1')
        await tick(10)
        log.push('a2')
      }),
      withKeyLock('k', async () => {
        log.push('b1')
        await tick(1)
        log.push('b2')
      })
    ])
    expect(log).toEqual(['a1', 'a2', 'b1', 'b2'])
  })

  it('a failed task rejects its caller but does not stop the next one', async () => {
    const failed = withKeyLock('f', async () => {
      throw new Error('boom')
    })
    let ran = false
    const next = withKeyLock('f', async () => {
      ran = true
    })
    await expect(failed).rejects.toThrow('boom')
    await next
    expect(ran).toBe(true)
  })

  it('different keys do not wait for each other', async () => {
    const log: string[] = []
    await Promise.all([
      withKeyLock('x', async () => {
        await tick(20)
        log.push('x')
      }),
      withKeyLock('y', async () => {
        log.push('y')
      })
    ])
    expect(log).toEqual(['y', 'x'])
  })
})
