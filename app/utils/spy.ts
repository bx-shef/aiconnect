// Protocol spy page helpers (pages/spy.vue): which ai.engine.* calls to make. Pure functions so
// the registration plan is covered by tests; the page only runs the calls.

/** One spy endpoint as returned by GET /api/spy. */
export interface SpyEngine {
  category: string
  code: string
  name: string
  completionsUrl: string
}

/** A provider as returned by `ai.engine.list` (fields measured on the test portal, docs/RESEARCH.md). */
export interface EngineRecord {
  code: string
  category: string
  completions_url: string
}

/** Records from an `ai.engine.list` answer; anything malformed is dropped. */
export function parseEngineList(raw: unknown): EngineRecord[] {
  if (!Array.isArray(raw)) return []
  return raw
    .map(r => r as Partial<EngineRecord> | null)
    .filter((r): r is EngineRecord => !!r && typeof r.code === 'string' && typeof r.category === 'string' && typeof r.completions_url === 'string')
}

/** `ai.engine.register` parameters for a spy endpoint (method docs: name, code, category, completions_url, settings). */
export function registerParams(engine: SpyEngine): Record<string, unknown> {
  return {
    name: engine.name,
    code: engine.code,
    category: engine.category,
    completions_url: engine.completionsUrl,
    settings: { model_context_type: 'token', model_context_limit: 16000 }
  }
}

export type EngineState = 'absent' | 'ok' | 'stale'

/** Is the spy registered for this category, and with the current completions_url (a server move makes it stale). */
export function engineState(engine: SpyEngine, registered: EngineRecord[]): EngineState {
  const found = registered.find(r => r.code === engine.code)
  if (!found) return 'absent'
  return found.completions_url === engine.completionsUrl ? 'ok' : 'stale'
}

export interface EngineCall {
  method: 'ai.engine.register' | 'ai.engine.unregister'
  params: Record<string, unknown>
}

/**
 * Calls that make the spy registered for `engines`. A second `register` with the same code fails
 * with ENGINE_REGISTER_ERROR_CODE_UNIQUE (measured 2026-09-28), so a stale one is unregistered
 * first and registered again.
 */
export function registerPlan(engines: SpyEngine[], registered: EngineRecord[]): EngineCall[] {
  const calls: EngineCall[] = []
  for (const engine of engines) {
    const state = engineState(engine, registered)
    if (state === 'ok') continue
    if (state === 'stale') calls.push({ method: 'ai.engine.unregister', params: { code: engine.code } })
    calls.push({ method: 'ai.engine.register', params: registerParams(engine) })
  }
  return calls
}

/** Calls that remove every spy endpoint that is registered. */
export function unregisterPlan(engines: SpyEngine[], registered: EngineRecord[]): EngineCall[] {
  return engines
    .filter(e => engineState(e, registered) !== 'absent')
    .map(e => ({ method: 'ai.engine.unregister' as const, params: { code: e.code } }))
}
