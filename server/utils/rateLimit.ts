// Rate limiting: portal events and live frame-token checks (keyed by client address).
// An in-process counter — we run a single server instance; horizontal scaling would need
// a shared one (Redis), see docs/ARCHITECTURE.md.

export interface WindowLimit {
  /** How many units are allowed per window (requests — or more, if an attempt weighs more than 1). */
  max: number
  windowMs: number
}

/**
 * Cap on keys held in memory: a flood of requests from thousands of addresses must not exhaust
 * memory. A key holds up to `max` hits (time and weight — two number arrays): 20,000 keys x 60
 * hits is roughly 20 MB.
 */
export const MAX_WINDOW_KEYS = 20_000
/** Stale-key cleanup runs once every this many `take` calls, not on every one. */
const PRUNE_EVERY = 256

interface Bucket {
  windowMs: number
  /** Hit timestamps in ascending order. */
  times: number[]
  /** Weight of each hit (parallel to `times`). */
  weights: number[]
}

/** A single window check: key, limit, and an optional weight for this attempt. */
export type WindowCheck = [key: string, limit: WindowLimit, weight?: number]

export class SlidingWindow {
  readonly #buckets = new Map<string, Bucket>()
  #calls = 0

  constructor(readonly maxKeys: number = MAX_WINDOW_KEYS) {}

  /** How many keys are currently in memory (for tests and diagnostics). */
  get size(): number {
    return this.#buckets.size
  }

  /**
   * Records an attempt across all windows at once; weight is per-check or falls back to `weight`.
   * `false` — at least one window is out of headroom, in which case the attempt isn't counted
   * ANYWHERE: otherwise a portal-limit rejection would eat into an employee's limit.
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
      // Delete and re-insert: Map preserves insertion order, and fresh keys move to the end —
      // on overflow, the ones not seen in a while get evicted.
      this.#buckets.delete(key)
      if (bucket.times.length) this.#buckets.set(key, bucket)
    }
    if (++this.#calls % PRUNE_EVERY === 0 || this.#buckets.size > this.maxKeys) this.#prune(now)
    return ok
  }

  /** Drops hits older than the window: a hit exactly `windowMs` ago no longer counts. */
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
   * Drops keys whose OWN window has expired (the window used to be a single shared hour, so keys
   * with a one-minute window lived 60x longer than needed). If there are still more keys than the
   * cap, evicts the least recently seen ones down to 90% of the cap, so a full pass is rare.
   * Eviction resets someone's counter, making the limit softer rather than stricter — but memory
   * stays bounded.
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
