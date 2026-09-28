// Ограничение частоты: события портала и живые проверки фрейм-токена (ключи — адрес клиента).
// Счётчик в памяти процесса — у нас один экземпляр сервера; при горизонтальном масштабировании
// понадобится общий (Redis), см. docs/ARCHITECTURE.md.

export interface WindowLimit {
  /** Сколько единиц разрешено в окне (запросов — или больше, если попытка весит больше 1). */
  max: number
  windowMs: number
}

/**
 * Потолок ключей в памяти: поток запросов с тысяч адресов не должен съесть память. Ключ хранит
 * до `max` попаданий (время и вес — два числовых массива): 20 000 ключей × 60 попаданий — порядка
 * 20 МБ.
 */
export const MAX_WINDOW_KEYS = 20_000
/** Чистка устаревших ключей — раз в столько вызовов `take`, а не на каждом. */
const PRUNE_EVERY = 256

interface Bucket {
  windowMs: number
  /** Моменты попаданий по возрастанию. */
  times: number[]
  /** Вес каждого попадания (параллельно `times`). */
  weights: number[]
}

/** Проверка одного окна: ключ, предел и (необязательно) свой вес попытки. */
export type WindowCheck = [key: string, limit: WindowLimit, weight?: number]

export class SlidingWindow {
  readonly #buckets = new Map<string, Bucket>()
  #calls = 0

  constructor(readonly maxKeys: number = MAX_WINDOW_KEYS) {}

  /** Сколько ключей сейчас в памяти (для тестов и диагностики). */
  get size(): number {
    return this.#buckets.size
  }

  /**
   * Учитывает попытку сразу во всех окнах; вес — свой у проверки или `weight`. `false` — хотя бы в
   * одном окне не хватает запаса, и тогда попытка не засчитывается НИГДЕ: иначе отказ по лимиту
   * портала съедал бы лимит сотрудника.
   */
  take(checks: WindowCheck[], now = Date.now(), weight = 1): boolean {
    const fresh = checks.map(([key, limit, own]) => {
      const bucket = this.#expire(this.#buckets.get(key), limit.windowMs, now)
      const used = bucket.weights.reduce((sum, w) => sum + w, 0)
      return { key, limit, bucket, used, w: own ?? weight }
    })
    const ok = fresh.every(({ limit, used, w }) => used + w <= limit.max)
    for (const { key, bucket, w } of fresh) {
      if (ok) {
        bucket.times.push(now)
        bucket.weights.push(w)
      }
      // Удалить и вставить заново: Map хранит порядок вставки, и свежие ключи уходят в конец —
      // при переполнении вытесняются давно не виденные.
      this.#buckets.delete(key)
      if (bucket.times.length) this.#buckets.set(key, bucket)
    }
    if (++this.#calls % PRUNE_EVERY === 0 || this.#buckets.size > this.maxKeys) this.#prune(now)
    return ok
  }

  /** Отбрасывает попадания старше окна: попадание ровно `windowMs` назад уже не считается. */
  #expire(prev: Bucket | undefined, windowMs: number, now: number): Bucket {
    if (!prev) return { windowMs, times: [], weights: [] }
    let drop = 0
    while (drop < prev.times.length && prev.times[drop]! <= now - windowMs) drop++
    if (drop) {
      prev.times.splice(0, drop)
      prev.weights.splice(0, drop)
    }
    prev.windowMs = windowMs
    return prev
  }

  /**
   * Снимает ключи, чьё СОБСТВЕННОЕ окно истекло (раньше окно было общим — час, и ключи с окном в
   * минуту жили в 60 раз дольше нужного). Если ключей всё ещё больше потолка — вытесняет самые
   * давно виденные до 90 % потолка, чтобы полный проход случался редко. Вытеснение сбрасывает
   * чужой счётчик, то есть делает лимит мягче, а не строже, — зато память ограничена.
   */
  #prune(now: number): void {
    for (const [key, bucket] of this.#buckets) {
      const last = bucket.times[bucket.times.length - 1]
      if (last === undefined || last <= now - bucket.windowMs) this.#buckets.delete(key)
    }
    if (this.#buckets.size <= this.maxKeys) return
    const target = Math.floor(this.maxKeys * 0.9)
    for (const key of this.#buckets.keys()) {
      if (this.#buckets.size <= target) break
      this.#buckets.delete(key)
    }
  }
}
