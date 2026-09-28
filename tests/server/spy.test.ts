import { randomBytes } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import {
  addCapture, engineGate, spyAccessError, CAPTURE_BUDGET_CHARS, CAPTURE_STRING_LIMIT, fitCaptureBudget, CAPTURES_PER_PORTAL, checkCallbackUrl, clearCaptures, echoCallbackBody, errorCallbackBody,
  getSpyMode, handleEngineRequest, listCaptures, updateCapture, memberIdFromSegment, portalSegment, sanitizeForCapture, setSpyMode, type Capture, type HandleDeps
} from '../../server/utils/spy'
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

describe('portal segment of completions_url', () => {
  it('round-trips the member_id', () => {
    expect(memberIdFromSegment(portalSegment(MEMBER, KEY), KEY)).toBe(MEMBER)
  })

  it('a forged or foreign signature is rejected', () => {
    const [id, sig] = portalSegment(MEMBER, KEY).split('.')
    expect(memberIdFromSegment(`${id}.${'A'.repeat(22)}`, KEY)).toBeNull()
    expect(memberIdFromSegment(`ffff${id!.slice(4)}.${sig}`, KEY)).toBeNull()
    expect(memberIdFromSegment(portalSegment(MEMBER, randomBytes(32)), KEY)).toBeNull()
    expect(memberIdFromSegment(MEMBER, KEY)).toBeNull()
    expect(memberIdFromSegment('', KEY)).toBeNull()
  })
})

describe('sanitizeForCapture', () => {
  it('auth keeps its shape, loses its values', () => {
    const out = sanitizeForCapture({ auth: { access_token: 'secret-token', member_id: MEMBER, expires: 3600 } }) as { auth: Record<string, unknown> }
    expect(out.auth).toEqual({ access_token: '<string:12>', member_id: `<string:${MEMBER.length}>`, expires: '<number>' })
    expect(JSON.stringify(out)).not.toContain('secret-token')
  })

  it('auth: null stays null (provider registered outside an app, docs)', () => {
    expect(sanitizeForCapture({ auth: null })).toEqual({ auth: null })
  })

  it('long strings are cut with the full length noted; short ones stay', () => {
    const long = 'x'.repeat(CAPTURE_STRING_LIMIT + 10)
    const out = sanitizeForCapture({ prompt: long, role: 'hi' }) as Record<string, string>
    expect(out.prompt).toBe(`${'x'.repeat(CAPTURE_STRING_LIMIT)}… [${long.length} chars]`)
    expect(out.role).toBe('hi')
  })

  it('nested audio prompt: structure kept, depth and array size bounded', () => {
    const deep: Record<string, unknown> = {}
    let cur = deep
    for (let i = 0; i < 10; i++) cur = (cur.n = {}) as Record<string, unknown>
    const out = sanitizeForCapture({ prompt: { file: 'f', fields: { type: 'mp3' } }, deep, list: Array.from({ length: 150 }, (_, i) => i) }) as Record<string, unknown>
    expect(out.prompt).toEqual({ file: 'f', fields: { type: 'mp3' } })
    expect(JSON.stringify(out.deep)).toContain('[depth limit]')
    expect((out.list as unknown[]).length).toBe(101)
    expect((out.list as unknown[]).at(-1)).toBe('[+50 items]')
  })
})

describe('checkCallbackUrl (SSRF guard for the callback)', () => {
  it('the portal\'s own https host passes and is marked same-portal', () => {
    const v = checkCallbackUrl(`https://${DOMAIN}/bitrix/services/main/ajax.php?action=x&hash=h`, DOMAIN, {})
    expect(v).toMatchObject({ ok: true, host: DOMAIN, samePortal: true })
  })

  it('another Bitrix24 portal passes the guard but is not same-portal', () => {
    expect(checkCallbackUrl('https://other.bitrix24.ru/x', DOMAIN, {})).toMatchObject({ ok: true, samePortal: false })
  })

  it.each([
    ['http', 'http://b24-test.bitrix24.by/x', 'not https'],
    ['foreign host', 'https://evil.example.com/x', 'not a Bitrix24 host'],
    ['look-alike host', 'https://b24-test.bitrix24.by.evil.com/x', 'not a Bitrix24 host'],
    ['credentials', 'https://u:p@b24-test.bitrix24.by/x', 'credentials in URL'],
    ['port', 'https://b24-test.bitrix24.by:8443/x', 'non-default port'],
    ['garbage', 'not a url', 'not a URL']
  ])('%s is refused', (_label, url, reason) => {
    expect(checkCallbackUrl(url, DOMAIN, {})).toEqual({ ok: false, reason })
  })

  it('missing is refused', () => {
    expect(checkCallbackUrl(undefined, DOMAIN, {})).toEqual({ ok: false, reason: 'missing' })
  })
})

describe('capture size budget', () => {
  it('a wide body of short strings is cut to a preview within the budget', () => {
    const wide = Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`k${i}`, Object.fromEntries(Array.from({ length: 100 }, (_, j) => [`s${j}`, 'x'.repeat(400)]))]))
    const out = fitCaptureBudget(sanitizeForCapture(wide)) as Record<string, string>
    expect(out.preview!.length).toBe(CAPTURE_BUDGET_CHARS)
    // Stored serialized: quotes inside the preview are escaped, so at most about twice the budget.
    expect(JSON.stringify(out).length).toBeLessThan(2 * CAPTURE_BUDGET_CHARS + 200)
    expect(out['[over budget]']).toMatch(/chars$/)
  })

  it('a small body is kept as is', () => {
    expect(fitCaptureBudget({ prompt: 'hi' })).toEqual({ prompt: 'hi' })
  })
})

describe('callback bodies (docs: AI в Битрикс24 — обзор методов)', () => {
  it('error: api_request_completed false — the portal gets its quota back', () => {
    expect(errorCallbackBody()).toMatchObject({ code: 503, api_request_completed: false })
  })

  it('echo: a string for text-like categories, nothing for image (it needs image URLs)', () => {
    expect(echoCallbackBody('text')?.result).toMatch(/тестовый ответ/)
    expect(echoCallbackBody('image')).toBeNull()
  })
})

describe('capture storage', () => {
  it('newest first, capped per portal; clear drops captures but keeps the mode', async () => {
    const kv = memoryKv()
    for (let i = 0; i < CAPTURES_PER_PORTAL + 5; i++) {
      await addCapture(kv, MEMBER, { id: `id${i}`, at: `t${i}`, category: 'text', keys: [], bodyBytes: 0, contentType: '', body: null, callback: { target: 'none' } })
    }
    const list = await listCaptures(kv, MEMBER)
    expect(list).toHaveLength(CAPTURES_PER_PORTAL)
    expect(list[0]!.at).toBe(`t${CAPTURES_PER_PORTAL + 4}`)
    await setSpyMode(kv, MEMBER, 'echo')
    await clearCaptures(kv, MEMBER)
    expect(await listCaptures(kv, MEMBER)).toEqual([])
    expect(await getSpyMode(kv, MEMBER)).toBe('echo')
  })

  it('concurrent adds and updates of one portal lose nothing (callback after 202 vs a new request)', async () => {
    const kv = memoryKv()
    const cap = (i: number): Capture => ({ id: `id${i}`, at: `t${i}`, category: 'text', keys: [], bodyBytes: 0, contentType: '', body: null, callback: { target: 'none' } })
    await addCapture(kv, MEMBER, cap(0))
    await Promise.all([
      ...Array.from({ length: 10 }, (_, i) => addCapture(kv, MEMBER, cap(i + 1))),
      updateCapture(kv, MEMBER, { ...cap(0), callback: { target: 'errorCallbackUrl', status: 200 } })
    ])
    const list = await listCaptures(kv, MEMBER)
    expect(list).toHaveLength(11)
    expect(list.find(c => c.id === 'id0')?.callback.status).toBe(200)
    expect(list.filter(c => c.callback.status === 200)).toHaveLength(1)
  })

  it('mode defaults to error; junk in storage reads as error', async () => {
    const kv = memoryKv()
    expect(await getSpyMode(kv, MEMBER)).toBe('error')
    kv.data.set(`spymode:${MEMBER}`, 'junk')
    expect(await getSpyMode(kv, MEMBER)).toBe('error')
  })

  it('uninstall (removePortal) wipes the spy data of that portal', async () => {
    const kv = memoryKv()
    await addCapture(kv, MEMBER, { id: 'x', at: 't', category: 'text', keys: [], bodyBytes: 0, contentType: '', body: null, callback: { target: 'none' } })
    await setSpyMode(kv, MEMBER, 'echo')
    await removePortal(kv, MEMBER)
    expect([...kv.data.keys()].filter(k => k.includes(MEMBER))).toEqual([])
  })
})

describe('handleEngineRequest', () => {
  const body = (over: Record<string, unknown> = {}) => JSON.stringify({
    prompt: 'Подготовь резюме',
    category: 'text',
    auth: { access_token: 'tok' },
    callbackUrl: `https://${DOMAIN}/bitrix/services/main/ajax.php?action=ok`,
    errorCallbackUrl: `https://${DOMAIN}/bitrix/services/main/ajax.php?action=err`,
    ttl: 14400,
    ...over
  })
  const deps = (over: Partial<HandleDeps> = {}) => {
    const kv = memoryKv()
    const postJson = vi.fn(async () => ({ status: 200 }))
    return { kv, postJson, deps: { kv, encKey: KEY, getPortalDomain: async (id: string) => id === MEMBER ? DOMAIN : null, postJson, env: { B24_SPY_PORTALS: `other.bitrix24.by, ${DOMAIN}` }, now: () => new Date('2026-09-28T12:00:00Z'), ...over } as HandleDeps }
  }
  const seg = () => portalSegment(MEMBER, KEY)

  it('202 at once; the follow-up posts the error callback to errorCallbackUrl and records the outcome', async () => {
    const { kv, postJson, deps: d } = deps()
    const v = await handleEngineRequest(seg(), 'text', body(), 'application/json', d)
    expect(v).toMatchObject({ status: 202, body: { result: 'OK' } })
    expect(postJson).not.toHaveBeenCalled()
    if (v.status !== 202) throw new Error('expected 202')
    await v.followUp()
    expect(postJson).toHaveBeenCalledWith(`https://${DOMAIN}/bitrix/services/main/ajax.php?action=err`, errorCallbackBody())
    const [capture] = await listCaptures(kv, MEMBER) as Capture[]
    expect(capture).toMatchObject({ category: 'text', contentType: 'application/json', callback: { target: 'errorCallbackUrl', status: 200, samePortal: true } })
    expect(capture!.keys).toContain('callbackUrl')
    expect(JSON.stringify(capture)).not.toContain('"tok"')
  })

  it('echo mode posts a test answer to callbackUrl', async () => {
    const { kv, postJson, deps: d } = deps()
    await setSpyMode(kv, MEMBER, 'echo')
    const v = await handleEngineRequest(seg(), 'text', body(), 'application/json', d)
    if (v.status !== 202) throw new Error('expected 202')
    await v.followUp()
    expect(postJson).toHaveBeenCalledWith(`https://${DOMAIN}/bitrix/services/main/ajax.php?action=ok`, echoCallbackBody('text'))
  })

  it('a callback to a host other than the portal is recorded, not called', async () => {
    const { kv, postJson, deps: d } = deps()
    const v = await handleEngineRequest(seg(), 'text', body({ errorCallbackUrl: 'https://other.bitrix24.ru/x' }), 'application/json', d)
    if (v.status !== 202) throw new Error('expected 202')
    await v.followUp()
    expect(postJson).not.toHaveBeenCalled()
    expect((await listCaptures(kv, MEMBER))[0]!.callback).toMatchObject({ target: 'none', host: 'other.bitrix24.ru', samePortal: false })
  })

  it('a failing callback is recorded, not thrown', async () => {
    const { kv, deps: d } = deps({ postJson: () => Promise.reject(new Error('timeout')) })
    const v = await handleEngineRequest(seg(), 'text', body(), 'application/json', d)
    if (v.status !== 202) throw new Error('expected 202')
    await expect(v.followUp()).resolves.toBeUndefined()
    expect((await listCaptures(kv, MEMBER))[0]!.callback.error).toBe('timeout')
  })

  it('unknown portal, forged segment or unknown category — 404 and nothing stored', async () => {
    const { kv, deps: d } = deps({ getPortalDomain: async () => null })
    expect((await handleEngineRequest(seg(), 'text', body(), '', d)).status).toBe(404)
    const { deps: d2 } = deps()
    expect((await handleEngineRequest(`${MEMBER}.${'A'.repeat(22)}`, 'text', body(), '', d2)).status).toBe(404)
    expect((await handleEngineRequest(seg(), 'video', body(), '', d2)).status).toBe(404)
    expect(kv.data.size).toBe(0)
  })

  it('portal not in B24_SPY_PORTALS — 404 and nothing stored (spy is a test-portal tool)', async () => {
    const { kv, deps: d } = deps({ env: { B24_SPY_PORTALS: 'other.bitrix24.by' } })
    expect(await handleEngineRequest(seg(), 'text', body(), 'application/json', d)).toMatchObject({ status: 404, body: { error: 'spy is off for this portal' } })
    const { deps: d2 } = deps({ env: {} })
    expect((await handleEngineRequest(seg(), 'text', body(), 'application/json', d2)).status).toBe(404)
    expect(kv.data.size).toBe(0)
  })

  it('a non-JSON body is still captured (to learn the format) and answered 400', async () => {
    const { kv, deps: d } = deps()
    const v = await handleEngineRequest(seg(), 'audio', 'prompt=x&file=y', 'application/x-www-form-urlencoded', d)
    expect(v.status).toBe(400)
    expect((await listCaptures(kv, MEMBER))[0]).toMatchObject({ category: 'audio', body: 'prompt=x&file=y', contentType: 'application/x-www-form-urlencoded' })
  })
})

describe('spyAccessError (/api/spy)', () => {
  const env = { B24_SPY_PORTALS: DOMAIN }
  it('admin on an allowed portal — allowed', () => {
    expect(spyAccessError(true, DOMAIN, env)).toBeNull()
  })
  it('not an admin — 403 even on an allowed portal (captures hold users\' prompts)', () => {
    expect(spyAccessError(false, DOMAIN, env)).toMatchObject({ status: 403, reason: 'not-admin' })
  })
  it('admin on a portal outside B24_SPY_PORTALS — off', () => {
    expect(spyAccessError(true, 'client.bitrix24.ru', env)).toMatchObject({ status: 403, reason: 'off' })
    expect(spyAccessError(true, DOMAIN, {})).toMatchObject({ reason: 'off' })
  })
})

describe('engineGate (before the body is read)', () => {
  const gateDeps = (allow = true) => ({ encKey: KEY, getPortalDomain: async (id: string) => id === MEMBER ? DOMAIN : null, allow: vi.fn(() => allow), env: { B24_SPY_PORTALS: DOMAIN } })
  const seg = () => portalSegment(MEMBER, KEY)

  it('registration GET/HEAD — ready, without spending the rate limit', async () => {
    const d = gateDeps()
    expect(await engineGate(seg(), 'text', 'GET', d)).toEqual({ ok: true, answer: 'ready', memberId: MEMBER })
    expect(await engineGate(seg(), 'call', 'head', d)).toMatchObject({ ok: true, answer: 'ready' })
    expect(d.allow).not.toHaveBeenCalled()
  })

  it('POST within the limit — read the body', async () => {
    expect(await engineGate(seg(), 'text', 'POST', gateDeps())).toEqual({ ok: true, answer: 'read-body', memberId: MEMBER })
  })

  it('POST over the per-portal limit — 429', async () => {
    expect(await engineGate(seg(), 'text', 'POST', gateDeps(false))).toMatchObject({ ok: false, status: 429 })
  })

  it('other methods — 405', async () => {
    expect(await engineGate(seg(), 'text', 'PUT', gateDeps())).toMatchObject({ ok: false, status: 405 })
  })

  it('forged signature, unknown category, not installed, spy off — 404 for every method', async () => {
    const d = gateDeps()
    for (const method of ['GET', 'POST']) {
      expect(await engineGate(`${MEMBER}.${'A'.repeat(22)}`, 'text', method, d)).toMatchObject({ status: 404 })
      expect(await engineGate(seg(), 'video', method, d)).toMatchObject({ status: 404 })
      expect(await engineGate(seg(), 'text', method, { ...d, getPortalDomain: async () => null })).toMatchObject({ status: 404 })
      expect(await engineGate(seg(), 'text', method, { ...d, env: {} })).toMatchObject({ status: 404 })
    }
    expect(d.allow).not.toHaveBeenCalled()
  })
})
