import { describe, expect, it } from 'vitest'
import { SlidingWindow } from '../../server/utils/rateLimit'

describe('SlidingWindow', () => {
  it('a denial on one window is not counted against another (portal limit does not eat the user limit)', () => {
    const w = new SlidingWindow()
    const user = { max: 3, windowMs: 60_000 }
    const portal = { max: 1, windowMs: 60_000 }
    expect(w.take([['u1', user], ['p', portal]], 0)).toBe(true)
    expect(w.take([['u2', user], ['p', portal]], 1)).toBe(false)
    // u2 is not counted: after the portal window it has its full budget.
    for (let i = 0; i < user.max; i++) expect(w.take([['u2', user]], 70_000 + i)).toBe(true)
    expect(w.take([['u2', user]], 70_000 + user.max)).toBe(false)
  })

  it('window boundary: a hit exactly windowMs ago no longer counts', () => {
    const w = new SlidingWindow()
    const lim = { max: 1, windowMs: 1000 }
    expect(w.take([['k', lim]], 0)).toBe(true)
    expect(w.take([['k', lim]], 999)).toBe(false)
    expect(w.take([['k', lim]], 1000)).toBe(true)
  })

  it('each check can have its own weight', () => {
    const w = new SlidingWindow()
    const requests = { max: 2, windowMs: 1000 }
    const rows = { max: 100, windowMs: 1000 }
    expect(w.take([['r', requests, 1], ['w', rows, 60]], 0)).toBe(true)
    // Not enough rows left — denied, and the request is not counted.
    expect(w.take([['r', requests, 1], ['w', rows, 41]], 1)).toBe(false)
    expect(w.take([['r', requests, 1], ['w', rows, 40]], 2)).toBe(true)
    // Not enough requests left, even though rows have plenty of room.
    expect(w.take([['r', requests, 1], ['w', rows, 0]], 3)).toBe(false)
  })

  it('the window slides', () => {
    const w = new SlidingWindow()
    const lim = { max: 2, windowMs: 1000 }
    expect(w.take([['k', lim]], 0)).toBe(true)
    expect(w.take([['k', lim]], 10)).toBe(true)
    expect(w.take([['k', lim]], 20)).toBe(false)
    expect(w.take([['k', lim]], 1001)).toBe(true)
  })

  it('weight: exactly the remainder is allowed, more than the remainder is denied and consumes nothing', () => {
    const w = new SlidingWindow()
    const lim = { max: 50, windowMs: 1000 }
    expect(w.take([['k', lim]], 0, 25)).toBe(true)
    expect(w.take([['k', lim]], 1, 26)).toBe(false)
    expect(w.take([['k', lim]], 2, 25)).toBe(true)
    expect(w.take([['k', lim]], 3, 1)).toBe(false)
  })

  it('a key is dropped according to ITS OWN window, not after an hour', () => {
    const w = new SlidingWindow()
    const short = { max: 5, windowMs: 1000 }
    w.take([['old', short]], 0)
    // Cleanup runs once every 256 calls: pad the call counter with other keys past the `old` window.
    for (let i = 0; i < 255; i++) w.take([['fresh', { max: 1000, windowMs: 1000 }]], 2000)
    expect(w.size).toBe(1)
  })

  it('key cap: entries not seen in a while are evicted, fresh ones keep their count', () => {
    const w = new SlidingWindow(10)
    const once = { max: 1, windowMs: 60 * 60_000 }
    for (let i = 0; i <= 10; i++) expect(w.take([[`k${i}`, once]], i)).toBe(true)
    expect(w.size).toBeLessThanOrEqual(10)
    // The freshest key still remembers its limit is exhausted; the oldest was evicted and starts over.
    expect(w.take([['k10', once]], 20)).toBe(false)
    expect(w.take([['k0', once]], 21)).toBe(true)
  })
})
