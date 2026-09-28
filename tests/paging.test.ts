import { describe, expect, it, vi } from 'vitest'
import { collectNumberedPages, collectOffsetPages } from '~/utils/paging'

/** Источник из `total` элементов, отдающий страницы по смещению. */
function offsetSource(total: number) {
  const data = Array.from({ length: total }, (_, i) => i)
  return vi.fn(async (offset: number) => data.slice(offset, offset + 50))
}

describe('collectOffsetPages', () => {
  it('читает до короткой страницы', async () => {
    const fetch = offsetSource(120)
    expect(await collectOffsetPages(fetch, 50, 10_000, 'много')).toHaveLength(120)
    expect(fetch).toHaveBeenCalledTimes(3)
  })

  it('ровно кратно странице — ещё один запрос, пустой, и конец', async () => {
    const fetch = offsetSource(100)
    expect(await collectOffsetPages(fetch, 50, 10_000, 'много')).toHaveLength(100)
    expect(fetch).toHaveBeenCalledTimes(3)
  })

  it('ровно потолок — не ошибка (раньше была ложная)', async () => {
    expect(await collectOffsetPages(offsetSource(200), 50, 200, 'много')).toHaveLength(200)
  })

  it('больше потолка — ошибка, а не тихо неполный список', async () => {
    await expect(collectOffsetPages(offsetSource(201), 50, 200, 'в счёте слишком много позиций')).rejects.toThrow('в счёте слишком много позиций')
  })

  it('потолок не кратен странице — ошибка программиста, а не неточная граница', async () => {
    await expect(collectOffsetPages(offsetSource(10), 50, 120, 'много')).rejects.toThrow(/multiple/)
  })
})

describe('collectNumberedPages', () => {
  const pages = (total: number, withTotal = true) => vi.fn(async (page: number) => {
    const rows = Array.from({ length: total }, (_, i) => i).slice((page - 1) * 50, page * 50)
    return withTotal ? { rows, total } : { rows }
  })

  it('останавливается по total, не запрашивая страницу за концом', async () => {
    const fetch = pages(100)
    expect(await collectNumberedPages(fetch, 50, 100, 'много')).toHaveLength(100)
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('без total — до короткой страницы; total 0 или мусор не считается нулём', async () => {
    const fetch = pages(120, false)
    expect(await collectNumberedPages(fetch, 50, 100, 'много')).toHaveLength(120)
    const zero = vi.fn(async (page: number) => ({ rows: page < 3 ? Array.from({ length: 50 }, () => 1) : [1], total: 0 }))
    expect(await collectNumberedPages(zero, 50, 100, 'много')).toHaveLength(101)
  })

  it('старый метод отдаёт последнюю страницу повторно — total не даёт задвоить', async () => {
    // Портал за концом возвращает последнюю страницу ещё раз; с total мы туда не ходим.
    const fetch = vi.fn(async (page: number) => ({ rows: Array.from({ length: 50 }, (_, i) => Math.min(page, 2) * 100 + i), total: 100 }))
    const rows = await collectNumberedPages(fetch, 50, 100, 'много')
    expect(new Set(rows).size).toBe(100)
  })

  it('упёрлись в потолок страниц, а данные есть — ошибка', async () => {
    await expect(collectNumberedPages(pages(250), 50, 4, 'слишком много записей')).rejects.toThrow('слишком много записей')
    await expect(collectNumberedPages(pages(250, false), 50, 4, 'слишком много записей')).rejects.toThrow('слишком много записей')
    expect(await collectNumberedPages(pages(200), 50, 4, 'много')).toHaveLength(200)
  })

  it('ровно потолок без total — не ошибка: пробная страница пустая или повторяет последнюю', async () => {
    expect(await collectNumberedPages(pages(200, false), 50, 4, 'много')).toHaveLength(200)
    // Старый метод за концом отдаёт последнюю страницу ещё раз — распознаём по ключу.
    const repeating = vi.fn(async (page: number) => ({ rows: Array.from({ length: 50 }, (_, i) => Math.min(page, 4) * 100 + i) }))
    expect(await collectNumberedPages(repeating, 50, 4, 'много', row => row)).toHaveLength(200)
    // Без ключа повтор не отличить от новых строк — честная ошибка.
    await expect(collectNumberedPages(repeating, 50, 4, 'много')).rejects.toThrow('много')
  })
})
