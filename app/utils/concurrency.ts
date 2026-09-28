// Параллельные вызовы с ограничением: чтения задач идут не по одному (десятки секунд на
// большой сделке — находка /code-review), но и не лавиной — SDK всё равно выравнивает их под
// лимит REST портала, а лавина лишь раздувает очередь.

/** Разбивает массив на куски не длиннее `size`. */
export function chunk<T>(items: readonly T[], size: number): T[][] {
  if (size < 1) throw new Error('chunk size must be ≥ 1')
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

/**
 * `Promise.all` с ограничением одновременных вызовов. Порядок результатов — как у входа.
 * Первая ошибка отклоняет весь вызов (как у `Promise.all`); уже запущенные вызовы доработают, а
 * НОВЫЕ не начинаются: иначе после отказа сбор строк ещё долго читал бы задачи в фоне, соревнуясь
 * с повторной попыткой за лимиты портала (находка /code-review). `limit` меньше 1 считается 1.
 */
export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0
  let failed = false
  async function worker(): Promise<void> {
    while (!failed && next < items.length) {
      const index = next++
      try {
        results[index] = await fn(items[index]!, index)
      } catch (e) {
        failed = true
        throw e
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(Math.max(1, limit), items.length) }, worker))
  return results
}
