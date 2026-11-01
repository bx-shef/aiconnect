// Per-key serialization of read-modify-write on the store. One process holds the store
// (docs/ARCHITECTURE.md), so an in-memory promise chain is enough.

const locks = new Map<string, Promise<void>>()

/** Runs `fn` after every earlier `fn` of the same key has settled; a failure does not break the chain. */
export async function withKeyLock(key: string, fn: () => Promise<void>): Promise<void> {
  const prev = locks.get(key) ?? Promise.resolve()
  const next = prev.then(fn, fn)
  const settled = next.catch(() => undefined)
  locks.set(key, settled)
  try {
    await next
  } finally {
    if (locks.get(key) === settled) locks.delete(key)
  }
}
