import { randomBytes } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { handleEngineRequest, listCaptures, portalSegment, type HandleDeps } from '../../server/utils/spy'
import {
  addJournalEntry, clearJournal, journalBody, exportJournal, getJournalEntry, getScenario, journalSummary, maskForJournal, parseScenario, rotate,
  setJournalCallback, setScenario, spyFullEnabled, type JournalEntry
} from '../../server/utils/spyJournal'
import { removePortal, type KeyValue } from '../../server/utils/tokenStore'

function memoryKv(): KeyValue & { data: Map<string, unknown> } {
  const data = new Map<string, unknown>()
  return {
    data,
    getItem: async key => structuredClone(data.get(key) ?? null),
    setItem: async (key, value) => void data.set(key, structuredClone(value)),
    removeItem: async key => void data.delete(key)
  }
}

const KEY = randomBytes(32)
const MEMBER = 'a1b2c3d4e5f60718293a4b5c6d7e8f90'
const DOMAIN = 'b24-test.bitrix24.by'
const LONG = 'You are BitrixGPT. '.repeat(400)

const entry = (id: string, over: Partial<JournalEntry> = {}): JournalEntry => ({
  id, at: `2026-11-01T00:00:0${id.length}Z`, scenario: '', category: 'text', contentType: 'application/json', size: 1, body: { prompt: id }, callback: { target: 'none' }, ...over
})

describe('spyFullEnabled', () => {
  it('only with B24_SPY_FULL=1 and only on a spy portal', () => {
    expect(spyFullEnabled(true, { B24_SPY_FULL: '1' })).toBe(true)
    expect(spyFullEnabled(true, { B24_SPY_FULL: ' 1 ' })).toBe(true)
    expect(spyFullEnabled(false, { B24_SPY_FULL: '1' })).toBe(false)
    expect(spyFullEnabled(true, {})).toBe(false)
    expect(spyFullEnabled(true, { B24_SPY_FULL: 'true' })).toBe(false)
    expect(spyFullEnabled(true, { B24_SPY_FULL: '0' })).toBe(false)
  })
})

describe('parseScenario', () => {
  it('empty means no label; a valid label passes trimmed', () => {
    expect(parseScenario(undefined)).toBe('')
    expect(parseScenario('  ')).toBe('')
    expect(parseScenario(' chat.deal-stage_1 ')).toBe('chat.deal-stage_1')
    expect(parseScenario('Chat.Deal')).toBe('chat.deal')
    expect(parseScenario('a'.repeat(64))).toBe('a'.repeat(64))
  })

  it('anything else is refused', () => {
    expect(parseScenario('a'.repeat(65))).toBeNull()
    expect(parseScenario('чат')).toBeNull()
    expect(parseScenario('../x')).toBeNull()
    expect(parseScenario('a b')).toBeNull()
    expect(parseScenario(5)).toBeNull()
  })
})

describe('maskForJournal', () => {
  it('long strings stay whole; personal data in texts stays (test portals, owner decision)', () => {
    const out = maskForJournal({ payload_role: LONG, prompt: 'Игорь_135: +375 29 000-00-00, a@b.by' }) as Record<string, string>
    expect(out.payload_role).toBe(LONG)
    expect(out.prompt).toContain('+375 29 000-00-00')
  })

  it('auth keeps its shape only; callback URLs keep their host only', () => {
    const out = maskForJournal({
      auth: { access_token: 'secret-token', nested: { refresh: 'r' }, expires: 3600 },
      callbackUrl: `https://${DOMAIN}/ajax.php?token=secret-cb`,
      errorCallbackUrl: 'not a url',
      deep: { callbackUrl: `https://${DOMAIN}/x?token=secret-deep` }
    }) as Record<string, unknown>
    expect(out.auth).toEqual({ access_token: '<string:12>', nested: { refresh: '<string:1>' }, expires: '<number>' })
    expect(out.callbackUrl).toBe(`<url:${DOMAIN}>`)
    expect(out.errorCallbackUrl).toBe('<string:9>')
    expect(JSON.stringify(out)).not.toContain('secret')
  })

  it('a raw non-JSON body is kept as is', () => {
    expect(maskForJournal('prompt=x')).toBe('prompt=x')
  })
})

describe('journalBody', () => {
  it('a parsed JSON value of any shape is masked, a top-level array too', () => {
    expect(journalBody([{ auth: { access_token: 'secret' } }], '')).toEqual([{ auth: { access_token: '<string:6>' } }])
  })

  it('a form-encoded body keeps its text, auth and callback values masked', () => {
    const raw = 'prompt=hello&auth%5Baccess_token%5D=secret1&auth[member_id]=secret2&callbackUrl=https%3A%2F%2Fx%3Ft%3Dsecret3&errorCallbackUrl=secret4&ttl=1'
    const out = journalBody(undefined, raw) as string
    expect(out).toContain('prompt=hello')
    expect(out).toContain('ttl=1')
    expect(out).toContain('auth%5Baccess_token%5D=<masked:7>')
    expect(out).not.toMatch(/secret/)
  })
})

describe('rotate', () => {
  const item = (id: string, bytes: number) => ({ id, at: '', scenario: '', category: 'text', bytes })

  it('keeps the newest within the count', () => {
    const r = rotate([item('c', 1), item('b', 1), item('a', 1)], 2, 100)
    expect(r.keep.map(i => i.id)).toEqual(['c', 'b'])
    expect(r.drop.map(i => i.id)).toEqual(['a'])
  })

  it('keeps the newest within the bytes; the newest stays even if it alone is over', () => {
    expect(rotate([item('c', 6), item('b', 4), item('a', 1)], 10, 10).keep.map(i => i.id)).toEqual(['c', 'b'])
    expect(rotate([item('c', 6), item('b', 5)], 10, 10).keep.map(i => i.id)).toEqual(['c'])
    expect(rotate([item('c', 50)], 10, 10).keep.map(i => i.id)).toEqual(['c'])
  })
})

describe('journal storage', () => {
  it('adds newest first, rotates out the oldest records from the store', async () => {
    const kv = memoryKv()
    for (const id of ['a', 'b', 'c']) await addJournalEntry(kv, MEMBER, entry(id), { maxEntries: 2 })
    expect((await exportJournal(kv, MEMBER)).map(e => e.id)).toEqual(['c', 'b'])
    expect(await getJournalEntry(kv, MEMBER, 'a')).toBeNull()
    expect([...kv.data.keys()].some(k => k.endsWith(':a'))).toBe(false)
  })

  it('export filters by scenario; summary counts records, bytes and labels', async () => {
    const kv = memoryKv()
    await addJournalEntry(kv, MEMBER, entry('a', { scenario: 'chat' }))
    await addJournalEntry(kv, MEMBER, entry('b', { scenario: 'tasks' }))
    await addJournalEntry(kv, MEMBER, entry('c'))
    expect((await exportJournal(kv, MEMBER, 'chat')).map(e => e.id)).toEqual(['a'])
    const s = await journalSummary(kv, MEMBER)
    expect(s.entries).toBe(3)
    expect(s.bytes).toBeGreaterThan(0)
    expect(s.scenarios.sort()).toEqual(['chat', 'tasks'])
  })

  it('an id outside the index is not read (no reading arbitrary keys)', async () => {
    const kv = memoryKv()
    kv.data.set(`spyjrec:${MEMBER}:planted`, entry('planted'))
    expect(await getJournalEntry(kv, MEMBER, 'planted')).toBeNull()
  })

  it('callback outcome is recorded; a rotated-out id is ignored', async () => {
    const kv = memoryKv()
    await addJournalEntry(kv, MEMBER, entry('a'))
    await setJournalCallback(kv, MEMBER, 'a', { target: 'errorCallbackUrl', status: 200 })
    await setJournalCallback(kv, MEMBER, 'gone', { target: 'none' })
    expect((await getJournalEntry(kv, MEMBER, 'a'))!.callback).toEqual({ target: 'errorCallbackUrl', status: 200 })
    expect(kv.data.has(`spyjrec:${MEMBER}:gone`)).toBe(false)
  })

  it('clear drops records and index; uninstall drops the scenario too', async () => {
    const kv = memoryKv()
    await addJournalEntry(kv, MEMBER, entry('a'))
    await setScenario(kv, MEMBER, 'chat')
    await clearJournal(kv, MEMBER)
    expect(await exportJournal(kv, MEMBER)).toEqual([])
    expect(await getScenario(kv, MEMBER)).toBe('chat')
    await addJournalEntry(kv, MEMBER, entry('b'))
    await removePortal(kv, MEMBER)
    expect([...kv.data.keys()].filter(k => k.includes(MEMBER))).toEqual([])
  })

  it('scenario: empty removes the label; junk in storage reads as none', async () => {
    const kv = memoryKv()
    await setScenario(kv, MEMBER, 'chat')
    await setScenario(kv, MEMBER, '')
    expect(await getScenario(kv, MEMBER)).toBe('')
    kv.data.set(`spyscenario:${MEMBER}`, '../../etc')
    expect(await getScenario(kv, MEMBER)).toBe('')
  })
})

describe('handleEngineRequest with the journal', () => {
  const body = () => JSON.stringify({
    prompt: 'Что будет?',
    payload_role: LONG,
    auth: { access_token: 'tok-secret' },
    callbackUrl: `https://${DOMAIN}/ajax.php?action=ok&t=cb-secret`,
    errorCallbackUrl: `https://${DOMAIN}/ajax.php?action=err&t=cb-secret`
  })
  const deps = (env: Record<string, string>) => {
    const kv = memoryKv()
    const postJson = vi.fn(async () => ({ status: 200 }))
    const log = vi.fn()
    const d = { kv, encKey: KEY, getPortalDomain: async () => DOMAIN, postJson, log, env: { B24_SPY_PORTALS: DOMAIN, ...env }, now: () => new Date('2026-11-01T06:43:09Z') } as HandleDeps
    return { kv, log, d }
  }
  const seg = () => portalSegment(MEMBER, KEY)

  it('full mode: the whole body goes to the journal, masked; capture and journal carry the scenario', async () => {
    const { kv, log, d } = deps({ B24_SPY_FULL: '1' })
    await setScenario(kv, MEMBER, 'chat.deal-stage')
    const v = await handleEngineRequest(seg(), 'text', body(), 'application/json', d)
    if (v.status !== 202) throw new Error('expected 202')
    await v.followUp()
    const [capture] = await listCaptures(kv, MEMBER)
    expect(capture).toMatchObject({ scenario: 'chat.deal-stage', journalId: capture!.id })
    const [rec] = await exportJournal(kv, MEMBER)
    expect(rec).toMatchObject({ id: capture!.id, scenario: 'chat.deal-stage', category: 'text', callback: { target: 'errorCallbackUrl', status: 200 } })
    expect((rec!.body as Record<string, unknown>).payload_role).toBe(LONG)
    expect(JSON.stringify(rec)).not.toMatch(/secret/)
    const line = log.mock.calls[0]![0] as string
    expect(line).toContain('scenario=chat.deal-stage')
    expect(line).not.toContain('BitrixGPT')
  })

  it('full mode, form body: answered 400, journal keeps the text with secrets masked', async () => {
    const { kv, d } = deps({ B24_SPY_FULL: '1' })
    const v = await handleEngineRequest(seg(), 'audio', 'prompt=x&auth[access_token]=tok-secret', 'application/x-www-form-urlencoded', d)
    expect(v.status).toBe(400)
    await vi.waitFor(async () => expect(await exportJournal(kv, MEMBER)).toHaveLength(1))
    const [rec] = await exportJournal(kv, MEMBER)
    expect(rec!.body).toBe('prompt=x&auth[access_token]=<masked:10>')
  })

  it('the short capture keeps only the host of callback URLs', async () => {
    const { kv, d } = deps({})
    await handleEngineRequest(seg(), 'text', body(), 'application/json', d)
    const [capture] = await listCaptures(kv, MEMBER)
    expect((capture!.body as Record<string, unknown>).callbackUrl).toBe(`<url:${DOMAIN}>`)
    expect(JSON.stringify(capture)).not.toMatch(/secret/)
  })

  it('without B24_SPY_FULL: no journal, the short capture still gets the scenario', async () => {
    const { kv, d } = deps({})
    await setScenario(kv, MEMBER, 'tasks')
    const v = await handleEngineRequest(seg(), 'text', body(), 'application/json', d)
    if (v.status !== 202) throw new Error('expected 202')
    await v.followUp()
    expect(await exportJournal(kv, MEMBER)).toEqual([])
    const [capture] = await listCaptures(kv, MEMBER)
    expect(capture).toMatchObject({ scenario: 'tasks' })
    expect(capture!.journalId).toBeUndefined()
  })
})
