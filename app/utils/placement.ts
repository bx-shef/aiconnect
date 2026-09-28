// Контекст встройки: какой счёт открыт. Чистые функции — тестируются без портала.

/**
 * ID счёта из PLACEMENT_OPTIONS. У нового счёта ключ — `ENTITY_ID` (у сделки был бы `ID`):
 * документация CRM_XXX_DETAIL_TOOLBAR, раздел PLACEMENT_OPTIONS. Регистр ключей — выбор портала,
 * поэтому читаем без учёта регистра.
 *
 * @returns ID или `null`, если в опциях его нет
 */
export function invoiceIdFromOptions(options: Readonly<Record<string, unknown>> | null | undefined): number | null {
  if (!options) return null
  for (const [key, value] of Object.entries(options)) {
    const k = key.toUpperCase()
    if (k !== 'ENTITY_ID' && k !== 'ID') continue
    const n = Number(value)
    if (Number.isInteger(n) && n > 0) return n
  }
  return null
}

/** ID счёта из строки запроса (`?id=12`) — для открытия страницы из главного экрана приложения. */
export function invoiceIdFromQuery(value: unknown): number | null {
  const raw = Array.isArray(value) ? value[0] : value
  const n = Number(raw)
  return Number.isInteger(n) && n > 0 ? n : null
}
