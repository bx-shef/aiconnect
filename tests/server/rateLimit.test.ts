import { describe, expect, it } from 'vitest'
import { AI_LIMITS, CONSULT_WEIGHT, SlidingWindow } from '../../server/utils/rateLimit'

describe('SlidingWindow', () => {
  it('отказ по одному окну не засчитывается в другом (лимит портала не съедает лимит сотрудника)', () => {
    const w = new SlidingWindow()
    const user = { max: 3, windowMs: 60_000 }
    const portal = { max: 1, windowMs: 60_000 }
    expect(w.take([['u1', user], ['p', portal]], 0)).toBe(true)
    expect(w.take([['u2', user], ['p', portal]], 1)).toBe(false)
    // u2 не засчитан: после окна портала у него полный запас.
    for (let i = 0; i < user.max; i++) expect(w.take([['u2', user]], 70_000 + i)).toBe(true)
    expect(w.take([['u2', user]], 70_000 + user.max)).toBe(false)
  })

  it('граница окна: попадание ровно windowMs назад уже не считается', () => {
    const w = new SlidingWindow()
    const lim = { max: 1, windowMs: 1000 }
    expect(w.take([['k', lim]], 0)).toBe(true)
    expect(w.take([['k', lim]], 999)).toBe(false)
    expect(w.take([['k', lim]], 1000)).toBe(true)
  })

  it('у каждой проверки может быть свой вес', () => {
    const w = new SlidingWindow()
    const requests = { max: 2, windowMs: 1000 }
    const rows = { max: 100, windowMs: 1000 }
    expect(w.take([['r', requests, 1], ['w', rows, 60]], 0)).toBe(true)
    // Строк не хватает — отказ, и запрос не засчитан.
    expect(w.take([['r', requests, 1], ['w', rows, 41]], 1)).toBe(false)
    expect(w.take([['r', requests, 1], ['w', rows, 40]], 2)).toBe(true)
    // Запросов не хватает, хотя строк — с запасом.
    expect(w.take([['r', requests, 1], ['w', rows, 0]], 3)).toBe(false)
  })

  it('окно скользит', () => {
    const w = new SlidingWindow()
    const lim = { max: 2, windowMs: 1000 }
    expect(w.take([['k', lim]], 0)).toBe(true)
    expect(w.take([['k', lim]], 10)).toBe(true)
    expect(w.take([['k', lim]], 20)).toBe(false)
    expect(w.take([['k', lim]], 1001)).toBe(true)
  })

  it('вес: ровно остаток — можно, больше остатка — отказ, и он ничего не съедает', () => {
    const w = new SlidingWindow()
    const lim = { max: 50, windowMs: 1000 }
    expect(w.take([['k', lim]], 0, 25)).toBe(true)
    expect(w.take([['k', lim]], 1, 26)).toBe(false)
    expect(w.take([['k', lim]], 2, 25)).toBe(true)
    expect(w.take([['k', lim]], 3, 1)).toBe(false)
  })

  it('ключ снимается по СВОЕМУ окну, а не через час', () => {
    const w = new SlidingWindow()
    const short = { max: 5, windowMs: 1000 }
    w.take([['old', short]], 0)
    // Чистка идёт раз в 256 вызовов: добиваем счётчик вызовов другими ключами позже окна `old`.
    for (let i = 0; i < 255; i++) w.take([['fresh', { max: 1000, windowMs: 1000 }]], 2000)
    expect(w.size).toBe(1)
  })

  it('потолок ключей: вытесняются давно не виденные, свежие сохраняют счёт', () => {
    const w = new SlidingWindow(10)
    const once = { max: 1, windowMs: 60 * 60_000 }
    for (let i = 0; i <= 10; i++) expect(w.take([[`k${i}`, once]], i)).toBe(true)
    expect(w.size).toBeLessThanOrEqual(10)
    // Самый свежий ключ помнит, что лимит исчерпан; самый старый вытеснен и начинает заново.
    expect(w.take([['k10', once]], 20)).toBe(false)
    expect(w.take([['k0', once]], 21)).toBe(true)
  })

  it('пределы BitrixGPT: большой счёт называется целиком, консультация весит пакет', () => {
    // 800 строк (32 пакета по 25) укладываются в лимиты сотрудника с запасом на пересборку.
    expect(AI_LIMITS.userRows.max).toBeGreaterThanOrEqual(800 * 2)
    expect(AI_LIMITS.userRequests.max).toBeGreaterThanOrEqual(32 * 2)
    expect(CONSULT_WEIGHT).toBe(25)
  })
})
