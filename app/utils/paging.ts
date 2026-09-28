// Сбор всех страниц списочных методов — чистые функции над «принеси страницу», чтобы границы
// (последняя страница, потолок, ровно потолок) проверялись тестом, а не только чтением кода
// (находка тестировщика панели: чтение страниц в useInvoiceFill.ts тестами не покрывалось).

/**
 * Страницы со смещением (`start` — crm.item.productrow.list и прочие новые методы). Конец —
 * страница короче `pageSize`. Прочитали `maxItems` полными страницами — запрашиваем ещё одну:
 * пустая — данных ровно `maxItems`, непустая — ошибка `overflowMessage`, а не тихо неполный
 * список (раньше ровно 10 000 позиций давали ложную ошибку — находка /code-review).
 */
export async function collectOffsetPages<T>(
  fetchPage: (offset: number) => Promise<T[]>,
  pageSize: number,
  maxItems: number,
  overflowMessage: string
): Promise<T[]> {
  // Иначе «ровно потолок» определялся бы неточно: последняя полная страница перелезла бы за него.
  if (maxItems % pageSize !== 0) throw new Error('maxItems must be a multiple of pageSize')
  const out: T[] = []
  for (let offset = 0; ; offset += pageSize) {
    const page = await fetchPage(offset)
    if (offset >= maxItems) {
      if (page.length === 0) return out
      throw new Error(overflowMessage)
    }
    out.push(...page)
    if (page.length < pageSize) return out
  }
}

export interface NumberedPage<T> {
  rows: T[]
  /** Всего строк по ответу портала; нет или 0 — неизвестно. */
  total?: unknown
}

/**
 * Страницы по номеру (1, 2, …) — старые методы с `NAV_PARAMS` (task.elapseditem.getlist). Конец —
 * страница короче `pageSize` или набранный `total`. Считаются СЫРЫЕ строки, а не разобранные:
 * иначе при одной битой строке мы запросили бы страницу за концом, а старые методы Битрикс24 на
 * ней, по опыту, отдают последнюю страницу ещё раз. `total` без значения не считается нулём —
 * иначе остановились бы после первой страницы.
 *
 * Прочитали `maxPages` полных страниц, а `total` неизвестен, — запрашиваем пробную: пустая или
 * сплошь из уже виденных строк (по `keyOf` — повтор последней страницы) — данных ровно на потолок;
 * есть новые — ошибка `overflowMessage`, а не тихо неполная сумма (раньше ровно потолок давал
 * ложную ошибку — находка программиста панели).
 */
export async function collectNumberedPages<T>(
  fetchPage: (page: number) => Promise<NumberedPage<T>>,
  pageSize: number,
  maxPages: number,
  overflowMessage: string,
  keyOf?: (row: T) => unknown
): Promise<T[]> {
  const out: T[] = []
  for (let page = 1; ; page++) {
    const { rows, total } = await fetchPage(page)
    if (page > maxPages) {
      const seen = keyOf ? new Set(out.map(keyOf)) : null
      if (rows.length === 0 || (seen && rows.every(r => seen.has(keyOf!(r))))) return out
      throw new Error(overflowMessage)
    }
    out.push(...rows)
    const known = typeof total === 'number' && Number.isFinite(total) && total > 0
    if (rows.length < pageSize || (known && out.length >= (total as number))) return out
  }
}
