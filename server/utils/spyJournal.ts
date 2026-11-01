// Full-text journal of the protocol spy (bx-shef/aiconnect#19): on a stand with B24_SPY_FULL=1 every
// request from a portal in B24_SPY_PORTALS is kept whole — prompts and system instructions are long
// and the 500-char cut of the short capture list eats them. Secrets are masked always: `auth`
// leaves only its shape, callback URLs only their host (they carry portal tokens). Personal data in
// the texts is kept as is: the portals are test ones (owner's decision, 2026-11-01). Stored in the
// `portals` volume of the stand, never in git. Pure functions over KeyValue — covered by tests.

import { withKeyLock } from './keyLock'
import type { KeyValue } from './tokenStore'

/** Records per portal; the oldest go first. */
export const JOURNAL_MAX_ENTRIES = 500
/** Stored JSON per portal, bytes; the oldest go first. */
export const JOURNAL_MAX_BYTES = 50 * 1024 * 1024
/** Guards against junk, not against real requests: far above any measured body. */
const JOURNAL_MAX_DEPTH = 32
const JOURNAL_MAX_KEYS = 10_000

/** Body keys that hold callback addresses with portal tokens in them. */
const CALLBACK_KEYS = new Set(['callbackUrl', 'errorCallbackUrl'])

/** The full mode works only with the stand switch and only for a spy portal. */
export function spyFullEnabled(spyOn: boolean, env: Record<string, string | undefined> = process.env): boolean {
  return spyOn && env.B24_SPY_FULL?.trim() === '1'
}

/** Scenario label: latin letters, digits, `.`, `_`, `-`, up to 64 chars. */
const SCENARIO_RE = /^[\w.-]{1,64}$/

/** Empty → no label (`''`); a valid label → itself; anything else → `null` (refuse). */
export function parseScenario(value: unknown): string | null {
  if (value === undefined || value === null) return ''
  if (typeof value !== 'string') return null
  const v = value.trim()
  if (!v) return ''
  return SCENARIO_RE.test(v) ? v : null
}

function maskShape(value: unknown, depth: number): unknown {
  if (value === null || value === undefined) return value
  if (typeof value === 'string') return `<string:${value.length}>`
  if (typeof value !== 'object') return `<${typeof value}>`
  if (depth >= JOURNAL_MAX_DEPTH) return '[depth limit]'
  if (Array.isArray(value)) return value.slice(0, JOURNAL_MAX_KEYS).map(v => maskShape(v, depth + 1))
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(value as Record<string, unknown>).slice(0, JOURNAL_MAX_KEYS)) out[k] = maskShape(v, depth + 1)
  return out
}

function maskUrl(value: unknown): unknown {
  if (typeof value !== 'string') return maskShape(value, 0)
  try {
    return `<url:${new URL(value).host}>`
  } catch {
    return `<string:${value.length}>`
  }
}

/** Whole body, strings uncut; `auth` → shape only, callback URLs → host only. */
export function maskForJournal(value: unknown, depth = 0, key = ''): unknown {
  if (key === 'auth') return maskShape(value, depth)
  if (CALLBACK_KEYS.has(key)) return maskUrl(value)
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
  callback: { target: string, host?: string, samePortal?: boolean, status?: number, error?: string }
}

/** Index line: what the page lists and what rotation counts, without the body. */
interface IndexItem { id: string, at: string, scenario: string, category: string, bytes: number }

const mid = (memberId: string) => memberId.toLowerCase()
const indexKey = (memberId: string) => `spyjindex:${mid(memberId)}`
const recordKey = (memberId: string, id: string) => `spyjrec:${mid(memberId)}:${id}`
const scenarioKey = (memberId: string) => `spyscenario:${mid(memberId)}`
const withLock = (memberId: string, fn: () => Promise<void>) => withKeyLock(`spyj:${mid(memberId)}`, fn)

async function readIndex(kv: KeyValue, memberId: string): Promise<IndexItem[]> {
  const value = await kv.getItem(indexKey(memberId))
  return Array.isArray(value) ? value as IndexItem[] : []
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
    for (const item of drop) await kv.removeItem(recordKey(memberId, item.id))
    await kv.setItem(indexKey(memberId), keep)
  })
}

/** Records the callback outcome on a stored entry (no-op if it was rotated out). */
export async function setJournalCallback(kv: KeyValue, memberId: string, id: string, callback: JournalEntry['callback']): Promise<void> {
  await withLock(memberId, async () => {
    const entry = await kv.getItem(recordKey(memberId, id)) as JournalEntry | null
    if (!entry || typeof entry !== 'object') return
    await kv.setItem(recordKey(memberId, id), { ...entry, callback })
  })
}

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
