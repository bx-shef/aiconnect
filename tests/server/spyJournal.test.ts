import { randomBytes } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { handleEngineRequest, listCaptures, portalSegment, type HandleDeps } from '../../server/utils/spy'
import {
  addJournalEntry, clearJournal, journalBody, JOURNAL_MAX_BODY_BYTES, parseJournalQuery, parseSpyPost, exportJournal, getJournalEntry, getScenario, journalSummary, maskForJournal, parseScenario, rotate,
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
  it('only with B24_SPY_FULL=1', () => {
    expect(spyFullEnabled({ B24_SPY_FULL: '1' })).toBe(true)
    expect(spyFullEnabled({ B24_SPY_FULL: ' 1 ' })).toBe(true)
    expect(spyFullEnabled({})).toBe(false)
    expect(spyFullEnabled({ B24_SPY_FULL: 'true' })).toBe(false)
    expect(spyFullEnabled({ B24_SPY_FULL: '0' })).toBe(false)
  })

  it('a portal outside B24_SPY_PORTALS gets no journal even with B24_SPY_FULL=1 (404, nothing stored)', async () => {
    const kv = memoryKv()
    const d = { kv, encKey: KEY, getPortalDomain: async () => DOMAIN, postJson: vi.fn(), env: { B24_SPY_FULL: '1', B24_SPY_PORTALS: 'other.bitrix24.by' } } as unknown as HandleDeps
    expect((await handleEngineRequest(portalSegment(MEMBER, KEY), 'text', '{"prompt":"x"}', 'application/json', d)).status).toBe(404)
    expect(kv.data.size).toBe(0)
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

  it('credential-looking keys anywhere are masked; max_tokens and the like are not', () => {
    const out = maskForJournal({ Auth: 'a1', access_token: 'secret-1', nested: { refresh_token: 'secret-2', client_secret: 'secret-3' }, error_callback_url: 'https://h.by/?t=secret-4', max_tokens: 1500, promptCategory: 'tasks' }) as Record<string, unknown>
    expect(JSON.stringify(out)).not.toMatch(/secret-|a1/)
    expect(out.max_tokens).toBe(1500)
    expect(out.promptCategory).toBe('tasks')
    expect(out.error_callback_url).toBe('<url:h.by>')
  })
})

describe('journalBody', () => {
  it('a parsed JSON value of any shape is masked, a top-level array too', () => {
    expect(journalBody([{ auth: { access_token: 'secret' } }], '')).toEqual([{ auth: { access_token: '<string:6>' } }])
  })

  it('broken JSON or multipart is not kept: its text could hold auth in a shape we do not parse', () => {
    expect(journalBody(undefined, '{"auth":{"access_token":"secret"},"prompt":"x')).toEqual({ '[raw not kept]': '45 bytes' })
    expect(journalBody(undefined, '--b\r\nContent-Disposition: form-data; name="auth"\r\n\r\nsecret')).toHaveProperty('[raw not kept]')
  })

  it('over the body cap only the keys are kept', () => {
    const big = { payload_role: 'x'.repeat(JOURNAL_MAX_BODY_BYTES), auth: { access_token: 'secret' } }
    expect(journalBody(big, JSON.stringify(big))).toEqual({ '[too big]': expect.stringContaining('bytes'), 'keys': ['payload_role', 'auth'] })
  })

  it('form names: case and tokens outside auth are masked too', () => {
    expect(journalBody(undefined, 'Auth[member_id]=secret1&access_token=secret2&max_tokens=10')).toBe('Auth[member_id]=<masked:7>&access_token=<masked:7>&max_tokens=10')
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

  it('concurrent adds of one portal lose no index line (the journal lock)', async () => {
    const kv = memoryKv()
    const set = kv.setItem
    kv.setItem = async (k, v) => {
      await new Promise(r => setTimeout(r, Math.random() * 5))
      return set(k, v)
    }
    await Promise.all(Array.from({ length: 8 }, (_, n) => addJournalEntry(kv, MEMBER, entry(`id${n}`))))
    expect((await journalSummary(kv, MEMBER)).entries).toBe(8)
  })

  it('member_id case does not matter (spy.ts keys by lowercase)', async () => {
    const kv = memoryKv()
    await addJournalEntry(kv, MEMBER.toUpperCase(), entry('a'))
    expect((await exportJournal(kv, MEMBER)).map(e => e.id)).toEqual(['a'])
  })

  it('a damaged index line is dropped, not summed as NaN; a missing record is skipped', async () => {
    const kv = memoryKv()
    await addJournalEntry(kv, MEMBER, entry('a'))
    const index = kv.data.get(`spyjindex:${MEMBER}`) as unknown[]
    kv.data.set(`spyjindex:${MEMBER}`, [...index, { id: 'junk' }, { id: 'gone', at: 't', scenario: '', category: 'text', bytes: 5 }, null])
    const s = await journalSummary(kv, MEMBER)
    expect(Number.isFinite(s.bytes)).toBe(true)
    expect(s.entries).toBe(2)
    expect((await exportJournal(kv, MEMBER)).map(e => e.id)).toEqual(['a'])
  })

  it('the real limits rotate by count', async () => {
    const kv = memoryKv()
    for (let n = 0; n < 502; n++) await addJournalEntry(kv, MEMBER, entry(`r${n}`))
    expect((await journalSummary(kv, MEMBER)).entries).toBe(500)
    expect(await getJournalEntry(kv, MEMBER, 'r0')).toBeNull()
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

describe('request parsers of /api/spy and /api/spy/journal', () => {
  it('journal: id → one record; otherwise all, narrowed by a valid label', () => {
    expect(parseJournalQuery({ id: 'abc' })).toEqual({ kind: 'one', id: 'abc' })
    expect(parseJournalQuery({})).toEqual({ kind: 'all', scenario: '' })
    expect(parseJournalQuery({ scenario: 'Chat' })).toEqual({ kind: 'all', scenario: 'chat' })
    expect(parseJournalQuery({ scenario: '../x' })).toMatchObject({ kind: 'bad' })
    expect(parseJournalQuery({ id: '' })).toEqual({ kind: 'all', scenario: '' })
  })

  it('post: clear, clearJournal, scenario, mode — in this order; a bad label is refused', () => {
    expect(parseSpyPost({ clear: true, clearJournal: true })).toEqual({ kind: 'clear' })
    expect(parseSpyPost({ clearJournal: true, scenario: 'x' })).toEqual({ kind: 'clearJournal' })
    expect(parseSpyPost({ scenario: 'chat', mode: 'echo' })).toEqual({ kind: 'scenario', scenario: 'chat' })
    expect(parseSpyPost({ scenario: '' })).toEqual({ kind: 'scenario', scenario: '' })
    expect(parseSpyPost({ scenario: 'чат' })).toMatchObject({ kind: 'bad' })
    expect(parseSpyPost({ mode: 'echo' })).toEqual({ kind: 'mode', mode: 'echo' })
    expect(parseSpyPost(null)).toEqual({ kind: 'mode', mode: undefined })
    expect(parseSpyPost({ clear: 'yes' })).toEqual({ kind: 'mode', mode: undefined })
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
    expect(rec).toMatchObject({ id: capture!.id, scenario: 'chat.deal-stage', category: 'text', size: Buffer.byteLength(body()), callback: { target: 'errorCallbackUrl', status: 200 } })
    expect((rec!.body as Record<string, unknown>).payload_role).toBe(LONG)
    expect(JSON.stringify(rec)).not.toMatch(/secret/)
    const line = log.mock.calls[0]![0] as string
    expect(line).toContain('scenario=chat.deal-stage')
    expect(line).not.toContain('BitrixGPT')
  })

  it('a slow journal write does not hold back the 202 (Bitrix24 waits at most 5 s)', async () => {
    const { kv, d } = deps({ B24_SPY_FULL: '1' })
    const set = kv.setItem
    // Slow, not hung: the journal lock is per portal and module-wide, a hung write would block later tests.
    kv.setItem = async (k, v) => k.startsWith('spyjrec:') ? new Promise<void>(r => setTimeout(() => void set(k, v).then(r), 800)) : set(k, v)
    const v = await Promise.race([
      handleEngineRequest(seg(), 'text', body(), 'application/json', d),
      new Promise(r => setTimeout(() => r('timeout'), 300))
    ])
    expect(v).toMatchObject({ status: 202 })
  })

  it('full mode, form body: answered 400, journal keeps the text with secrets masked', async () => {
    const { kv, d } = deps({ B24_SPY_FULL: '1' })
    const v = await handleEngineRequest(seg(), 'audio', 'prompt=x&auth[access_token]=tok-secret', 'application/x-www-form-urlencoded', d)
    expect(v.status).toBe(400)
    await vi.waitFor(async () => expect(await exportJournal(kv, MEMBER)).toHaveLength(1), { timeout: 3000 })
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
