// Full-text journal of the protocol spy (bx-shef/aiconnect#19): on a stand with B24_SPY_FULL=1 every
// request from a portal in B24_SPY_PORTALS is kept whole — prompts and system instructions are long
// and the 500-char cut of the short capture list eats them. Secrets are masked always: `auth`
// leaves only its shape, callback URLs only their host (they carry portal tokens). Personal data in
// the texts is kept as is: the portals are test ones (owner's decision, 2026-11-01). Stored in the
// `portals` volume of the stand, never in git. Pure functions over KeyValue — covered by tests.
// Temporary: a reconnaissance tool of stage 1 — remove with the spy once #19 is closed.

import { withKeyLock } from './keyLock'
import type { CallbackOutcome } from './spy'
import { maskByKey } from './spyMask'
import type { KeyValue } from './tokenStore'

/** Records per portal; the oldest go first. */
export const JOURNAL_MAX_ENTRIES = 500
/** Stored JSON per portal, bytes; the oldest go first. */
export const JOURNAL_MAX_BYTES = 50 * 1024 * 1024
/**
 * A raw body above this is not journaled whole: the record keeps its keys and a note. nginx-proxy
 * already cuts bodies over 1 MB (docs/DEPLOY.md §4) — this bounds memory and disk if it is raised.
 */
export const JOURNAL_MAX_BODY_BYTES = 4 * 1024 * 1024
/** Guards against junk, not against real requests: far above any measured body. */
const JOURNAL_MAX_DEPTH = 32
const JOURNAL_MAX_KEYS = 10_000

/**
 * The stand switch of the full mode. Callers check the spy portal list first (`spyAccessError`,
 * `handleEngineRequest`): the journal works only for portals in B24_SPY_PORTALS.
 */
export function spyFullEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.B24_SPY_FULL?.trim() === '1'
}

/** Scenario label: latin letters (stored lowercase), digits, `.`, `_`, `-`, up to 64 chars. */
const SCENARIO_RE = /^[\w.-]{1,64}$/

/** Empty → no label (`''`); a valid label → itself; anything else → `null` (refuse). */
export function parseScenario(value: unknown): string | null {
  if (value === undefined || value === null) return ''
  if (typeof value !== 'string') return null
  const v = value.trim().toLowerCase()
  if (!v) return ''
  return SCENARIO_RE.test(v) ? v : null
}

/** Whole body, strings uncut; credentials → shape only, callback URLs → host only (spyMask.ts). */
export function maskForJournal(value: unknown, depth = 0, key = ''): unknown {
  const masked = key ? maskByKey(key, value, JOURNAL_MAX_DEPTH, JOURNAL_MAX_KEYS, depth) : undefined
  if (masked !== undefined) return masked
  if (value === null || typeof value !== 'object') return value
  if (depth >= JOURNAL_MAX_DEPTH) return '[depth limit]'
  if (Array.isArray(value)) {
    const items = value.slice(0, JOURNAL_MAX_KEYS).map(v => maskForJournal(v, depth + 1))
    return value.length > JOURNAL_MAX_KEYS ? [...items, `[+${value.length - JOURNAL_MAX_KEYS} items]`] : items
  }
  const out: Record<string, unknown> = {}
  const entries = Object.entries(value as Record<string, unknown>)
  for (const [k, v] of entries.slice(0, JOURNAL_MAX_KEYS)) out[k] = maskForJournal(v, depth + 1, k)
  if (entries.length > JOURNAL_MAX_KEYS) out['[more keys]'] = entries.length - JOURNAL_MAX_KEYS
  return out
}

/** A form-encoded body: `name=value` pairs joined by `&`, no JSON or multipart framing. */
const FORM_RE = /^[\w.%[\]-]+=[^&]*(?:&[\w.%[\]-]+=[^&]*)*$/
/** Form pair names that carry credentials: `auth`, `auth[...]`, tokens, secrets, callback URLs. */
const FORM_SECRET_NAME_RE = /^(?:auth(?:%5B|\[|$)|(?:error_?)?callback_?url$)|(?:^|_)token(?:%5D|\])?$|secret|password/i

/**
 * Journal body. A parsed JSON value goes through {@link maskForJournal}; a form-encoded body keeps
 * its text with credential values masked; anything else (broken JSON, multipart) is not kept — its
 * text could hold `auth` in a shape we do not parse (finding of the review panel). Over
 * {@link JOURNAL_MAX_BODY_BYTES} only the top-level keys are kept.
 */
export function journalBody(parsed: unknown, raw: string): unknown {
  const bytes = Buffer.byteLength(raw)
  if (parsed !== undefined && parsed !== null && typeof parsed === 'object') {
    if (bytes > JOURNAL_MAX_BODY_BYTES) return { '[too big]': `${bytes} bytes`, 'keys': Array.isArray(parsed) ? `array:${parsed.length}` : Object.keys(parsed) }
    return maskForJournal(parsed)
  }
  if (bytes > JOURNAL_MAX_BODY_BYTES || !FORM_RE.test(raw)) return { '[raw not kept]': `${bytes} bytes` }
  return raw.split('&').map((pair) => {
    const eq = pair.indexOf('=')
    const name = pair.slice(0, eq)
    return FORM_SECRET_NAME_RE.test(name) ? `${name}=<masked:${pair.length - eq - 1}>` : pair
  }).join('&')
}

/** One journal record: the request as received (masked), with its scenario and callback outcome. */
export interface JournalEntry {
  id: string
  at: string
  scenario: string
  category: string
  contentType: string
  /** Bytes of the raw request body. */
  size: number
  body: unknown
  callback: CallbackOutcome
}

/** Index line: what the page lists and what rotation counts, without the body. */
interface IndexItem { id: string, at: string, scenario: string, category: string, bytes: number }

const mid = (memberId: string) => memberId.toLowerCase()
const indexKey = (memberId: string) => `spyjindex:${mid(memberId)}`
const recordKey = (memberId: string, id: string) => `spyjrec:${mid(memberId)}:${id}`
const scenarioKey = (memberId: string) => `spyscenario:${mid(memberId)}`
const withLock = (memberId: string, fn: () => Promise<void>) => withKeyLock(`spyj:${mid(memberId)}`, fn)

const isIndexItem = (v: unknown): v is IndexItem => {
  const i = v as IndexItem | null
  return !!i && typeof i === 'object' && typeof i.id === 'string' && typeof i.at === 'string'
    && typeof i.scenario === 'string' && typeof i.category === 'string' && Number.isFinite(i.bytes)
}

/** The portal's index; a damaged line (cut write, junk) is dropped instead of breaking the sums. */
async function readIndex(kv: KeyValue, memberId: string): Promise<IndexItem[]> {
  const value = await kv.getItem(indexKey(memberId))
  return Array.isArray(value) ? value.filter(isIndexItem) : []
}

/** Newest first; drops the oldest beyond `maxEntries` or `maxBytes` (the newest one always stays). */
export function rotate(index: IndexItem[], maxEntries = JOURNAL_MAX_ENTRIES, maxBytes = JOURNAL_MAX_BYTES): { keep: IndexItem[], drop: IndexItem[] } {
  const keep: IndexItem[] = []
  let bytes = 0
  for (const item of index) {
    if (keep.length && (keep.length >= maxEntries || bytes + item.bytes > maxBytes)) break
    keep.push(item)
    bytes += item.bytes
  }
  return { keep, drop: index.slice(keep.length) }
}

export interface JournalLimits { maxEntries?: number, maxBytes?: number }

/** Adds a record on top and rotates the portal's journal. */
export async function addJournalEntry(kv: KeyValue, memberId: string, entry: JournalEntry, limits: JournalLimits = {}): Promise<void> {
  await withLock(memberId, async () => {
    const bytes = Buffer.byteLength(JSON.stringify(entry))
    await kv.setItem(recordKey(memberId, entry.id), entry)
    const { keep, drop } = rotate(
      [{ id: entry.id, at: entry.at, scenario: entry.scenario, category: entry.category, bytes }, ...await readIndex(kv, memberId)],
      limits.maxEntries, limits.maxBytes
    )
    // Index first: a failure while removing leaves orphan files, never index lines without records.
    await kv.setItem(indexKey(memberId), keep)
    await Promise.allSettled(drop.map(item => kv.removeItem(recordKey(memberId, item.id))))
  })
}

/** Records the callback outcome on a stored entry (no-op if it was rotated out). */
export async function setJournalCallback(kv: KeyValue, memberId: string, id: string, callback: CallbackOutcome): Promise<void> {
  await withLock(memberId, async () => {
    const entry = await kv.getItem(recordKey(memberId, id)) as JournalEntry | null
    if (!entry || typeof entry !== 'object') return
    await kv.setItem(recordKey(memberId, id), { ...entry, callback })
  })
}

/** One record by id — only an id from the portal's index is read (no reading arbitrary keys). */
export async function getJournalEntry(kv: KeyValue, memberId: string, id: string): Promise<JournalEntry | null> {
  if (!(await readIndex(kv, memberId)).some(i => i.id === id)) return null
  const entry = await kv.getItem(recordKey(memberId, id))
  return entry && typeof entry === 'object' ? entry as JournalEntry : null
}

/** Whole records, newest first; `scenario` — only that label (`''` — all). */
export async function exportJournal(kv: KeyValue, memberId: string, scenario = ''): Promise<JournalEntry[]> {
  const out: JournalEntry[] = []
  for (const item of await readIndex(kv, memberId)) {
    if (scenario && item.scenario !== scenario) continue
    const entry = await kv.getItem(recordKey(memberId, item.id))
    if (entry && typeof entry === 'object') out.push(entry as JournalEntry)
  }
  return out
}

/** For the page: how much is kept and under which labels. */
export async function journalSummary(kv: KeyValue, memberId: string): Promise<{ entries: number, bytes: number, scenarios: string[] }> {
  const index = await readIndex(kv, memberId)
  return {
    entries: index.length,
    bytes: index.reduce((n, i) => n + i.bytes, 0),
    scenarios: [...new Set(index.map(i => i.scenario).filter(Boolean))]
  }
}

export async function clearJournal(kv: KeyValue, memberId: string): Promise<void> {
  await withLock(memberId, async () => {
    for (const item of await readIndex(kv, memberId)) await kv.removeItem(recordKey(memberId, item.id))
    await kv.removeItem(indexKey(memberId))
  })
}

/** What GET /api/spy/journal was asked for: one record, all (by label) or a bad request. */
export type JournalQuery = { kind: 'one', id: string } | { kind: 'all', scenario: string } | { kind: 'bad', message: string }

export function parseJournalQuery(query: Record<string, unknown>): JournalQuery {
  if (typeof query.id === 'string' && query.id) return { kind: 'one', id: query.id }
  const scenario = parseScenario(query.scenario)
  return scenario === null ? { kind: 'bad', message: 'bad scenario' } : { kind: 'all', scenario }
}

/** What POST /api/spy was asked to do; the first matching field wins, in this order. */
export type SpyPostAction = { kind: 'clear' } | { kind: 'clearJournal' } | { kind: 'scenario', scenario: string } | { kind: 'mode', mode: unknown } | { kind: 'bad', message: string }

export function parseSpyPost(body: Record<string, unknown> | null): SpyPostAction {
  if (body?.clear === true) return { kind: 'clear' }
  if (body?.clearJournal === true) return { kind: 'clearJournal' }
  if (body && 'scenario' in body) {
    const scenario = parseScenario(body.scenario)
    return scenario === null ? { kind: 'bad', message: 'scenario: latin letters, digits, ".", "_", "-", up to 64 chars' } : { kind: 'scenario', scenario }
  }
  return { kind: 'mode', mode: body?.mode }
}

export async function getScenario(kv: KeyValue, memberId: string): Promise<string> {
  return parseScenario(await kv.getItem(scenarioKey(memberId))) || ''
}

export async function setScenario(kv: KeyValue, memberId: string, scenario: string): Promise<void> {
  if (scenario) await kv.setItem(scenarioKey(memberId), scenario)
  else await kv.removeItem(scenarioKey(memberId))
}

/** Everything the journal keeps for a portal (app uninstall). */
export async function clearJournalData(kv: KeyValue, memberId: string): Promise<void> {
  await clearJournal(kv, memberId)
  await kv.removeItem(scenarioKey(memberId))
}
