// What the protocol spy never stores in the clear, shared by the short capture list (spy.ts) and
// the full journal (spyJournal.ts) so the two cannot drift apart (finding of the review panel).
// The body schema of Bitrix24 is not fully measured yet (docs/PROTOCOL.md), so besides the known
// `auth` and callback URLs any key that looks like a credential is masked too.

/** Keys whose value is a credential: `auth` (any case), `*_token`, `token`, `*secret*`, `*password*`. */
const SECRET_KEY_RE = /^auth$|(?:^|_)token$|secret|password/i
/** Keys whose value is a callback URL with portal tokens in the query. */
const CALLBACK_KEY_RE = /^(?:error_?)?callback_?url$/i

export const isSecretKey = (key: string): boolean => SECRET_KEY_RE.test(key)
export const isCallbackKey = (key: string): boolean => CALLBACK_KEY_RE.test(key)

/** Shape without values: every leaf becomes `<type:length>`, keys stay visible. */
export function maskShape(value: unknown, maxDepth: number, maxKeys: number, depth = 0): unknown {
  if (value === null || value === undefined) return value
  if (typeof value === 'string') return `<string:${value.length}>`
  if (typeof value !== 'object') return `<${typeof value}>`
  if (depth >= maxDepth) return '[depth limit]'
  if (Array.isArray(value)) return value.slice(0, maxKeys).map(v => maskShape(v, maxDepth, maxKeys, depth + 1))
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(value as Record<string, unknown>).slice(0, maxKeys)) out[k] = maskShape(v, maxDepth, maxKeys, depth + 1)
  return out
}

/** Callback URL → its host only. */
export function maskUrl(value: unknown): unknown {
  if (typeof value !== 'string') return maskShape(value, 2, 10)
  try {
    return `<url:${new URL(value).host}>`
  } catch {
    return `<string:${value.length}>`
  }
}

/** Masked value for a key, or `undefined` when the key is not a secret one. */
export function maskByKey(key: string, value: unknown, maxDepth: number, maxKeys: number, depth: number): unknown {
  if (isCallbackKey(key)) return maskUrl(value)
  if (isSecretKey(key) && value !== null && value !== undefined) return maskShape(value, maxDepth, maxKeys, depth)
  return undefined
}
