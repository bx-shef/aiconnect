import { randomBytes } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { extractFrameAuth, frameCacheSize, isAuthRejection, resetFrameCache, VERIFY_CACHE_MAX, VERIFY_CACHE_MS, verifyFrame, type VerifyDeps } from '../../server/utils/frameAuth'
import { saveInstall, type KeyValue } from '../../server/utils/tokenStore'

const APP = 'local.ours'

function memoryKv(): KeyValue {
  const data = new Map<string, unknown>()
  return {
    getItem: async key => data.get(key) ?? null,
    setItem: async (key, value) => void data.set(key, value),
    removeItem: async key => void data.delete(key)
  }
}

function headers(map: Record<string, string>) {
  return { get: (name: string) => map[name] ?? null }
}

/** Portal responds like the real thing: `profile` — the employee, `app.info` — our application. */
function portal(profile: Record<string, unknown> = { ID: '7' }, code = APP) {
  return vi.fn(async (_d: string, _t: string, method: string) => (method === 'profile' ? profile : { CODE: code }))
}

beforeEach(() => {
  vi.stubEnv('B24_TOKEN_ENC_KEY', randomBytes(32).toString('hex'))
  resetFrameCache()
})

afterEach(() => {
  vi.unstubAllEnvs()
})

async function installedKv(): Promise<KeyValue> {
  const kv = memoryKv()
  await saveInstall(kv, { memberId: 'm1', domain: 'demo.bitrix24.ru', accessToken: 'a', refreshToken: 'r', expiresIn: 3600, applicationToken: 't' })
  return kv
}

describe('extractFrameAuth', () => {
  it('takes the Bearer token and domain (including with protocol, as the SDK sends it)', () => {
    expect(extractFrameAuth(headers({ 'authorization': 'Bearer tok', 'x-b24-domain': 'https://demo.bitrix24.ru' }), {}))
      .toEqual({ domain: 'demo.bitrix24.ru', accessToken: 'tok' })
  })

  it('disallowed domain, no token, or not Bearer — null', () => {
    expect(extractFrameAuth(headers({ 'authorization': 'Bearer tok', 'x-b24-domain': 'evil.com' }), {})).toBeNull()
    expect(extractFrameAuth(headers({ 'x-b24-domain': 'demo.bitrix24.ru' }), {})).toBeNull()
    expect(extractFrameAuth(headers({ 'authorization': 'Basic tok', 'x-b24-domain': 'demo.bitrix24.ru' }), {})).toBeNull()
  })
})

describe('verifyFrame', () => {
  const auth = { domain: 'demo.bitrix24.ru', accessToken: 'tok' }

  it('without B24_APP_CODE — 503, not a skipped check; no call to the portal', async () => {
    const call = portal()
    const res = await verifyFrame(auth, { kv: await installedKv(), call, appCode: '' })
    expect(res).toMatchObject({ ok: false, status: 503 })
    expect(call).not.toHaveBeenCalled()
  })

  it('portal without an install — 409, no call to the portal at all', async () => {
    const call = portal()
    const res = await verifyFrame(auth, { kv: memoryKv(), call, appCode: APP })
    expect(res).toMatchObject({ ok: false, status: 409 })
    expect(call).not.toHaveBeenCalled()
  })

  it('user and admin flag — from profile', async () => {
    const res = await verifyFrame(auth, { kv: await installedKv(), call: portal({ ID: '7', ADMIN: true }), appCode: APP })
    expect(res).toMatchObject({ ok: true, user: { userId: 7, isAdmin: true } })
  })

  it('ADMIN as the string "true" — not an admin (strict check)', async () => {
    const res = await verifyFrame(auth, { kv: await installedKv(), call: portal({ ID: '7', ADMIN: 'true' }), appCode: APP })
    expect(res).toMatchObject({ ok: true, user: { isAdmin: false } })
  })

  it('profile without an employee — 401', async () => {
    expect(await verifyFrame(auth, { kv: await installedKv(), call: portal({}), appCode: APP })).toMatchObject({ ok: false, status: 401 })
  })

  it('another application\'s token on the same portal — 403', async () => {
    const deps: VerifyDeps = { kv: await installedKv(), appCode: APP, call: portal({ ID: 7 }, 'local.other') }
    expect(await verifyFrame(auth, deps)).toMatchObject({ ok: false, status: 403 })
  })

  it('live-check limit exhausted — 429 and no call to the portal; a cached decision does not spend the limit', async () => {
    const kv = await installedKv()
    const call = portal()
    expect(await verifyFrame(auth, { kv, call, appCode: APP, allowLiveCheck: () => false })).toMatchObject({ ok: false, status: 429 })
    expect(call).not.toHaveBeenCalled()
    const allow = vi.fn(() => true)
    await verifyFrame(auth, { kv, call, appCode: APP, allowLiveCheck: allow })
    await verifyFrame(auth, { kv, call, appCode: APP, allowLiveCheck: () => false })
    expect(allow).toHaveBeenCalledTimes(1)
  })

  it('rejected token — 401, portal failure — 502', async () => {
    const kv = await installedKv()
    expect(await verifyFrame(auth, { kv, appCode: APP, call: async () => {
      throw new Error('expired_token: The access token provided has expired')
    } })).toMatchObject({ status: 401 })
    resetFrameCache()
    expect(await verifyFrame(auth, { kv, appCode: APP, call: async () => {
      throw new Error('ECONNRESET')
    } })).toMatchObject({ status: 502 })
  })

  it('a portal failure is not cached: the next request checks again', async () => {
    const kv = await installedKv()
    let fail = true
    const call = vi.fn(async (_d: string, _t: string, method: string) => {
      if (fail) throw new Error('ECONNRESET')
      return method === 'profile' ? { ID: 7 } : { CODE: APP }
    })
    expect(await verifyFrame(auth, { kv, call, appCode: APP })).toMatchObject({ status: 502 })
    fail = false
    expect(await verifyFrame(auth, { kv, call, appCode: APP })).toMatchObject({ ok: true })
  })

  it('caches the decision for a token for exactly VERIFY_CACHE_MS', async () => {
    const call = portal()
    const kv = await installedKv()
    let now = 1_000
    const deps = { kv, call, appCode: APP, now: () => now }
    await verifyFrame(auth, deps)
    now += VERIFY_CACHE_MS - 1
    await verifyFrame(auth, deps)
    // Two calls for the check (profile + app.info), and only one check total.
    expect(call).toHaveBeenCalledTimes(2)
    now += 1
    await verifyFrame(auth, deps)
    expect(call).toHaveBeenCalledTimes(4)
  })

  it('cache overflow evicts old entries, not the whole cache', async () => {
    const kv = await installedKv()
    const call = portal()
    const deps = { kv, call, appCode: APP, now: () => 1_000 }
    for (let i = 0; i < VERIFY_CACHE_MAX + 1; i++) await verifyFrame({ ...auth, accessToken: `t${i}` }, deps)
    const before = call.mock.calls.length
    // Fresh tokens written BEFORE the overflow are still cached — no full reset happened.
    await verifyFrame({ ...auth, accessToken: `t${VERIFY_CACHE_MAX - 1}` }, deps)
    await verifyFrame({ ...auth, accessToken: `t${VERIFY_CACHE_MAX}` }, deps)
    expect(call.mock.calls.length).toBe(before)
    // The oldest one was evicted — checked again.
    await verifyFrame({ ...auth, accessToken: 't0' }, deps)
    expect(call.mock.calls.length).toBe(before + 2)
  })

  it('on overflow ALL expired entries are dropped first, fresh ones untouched', async () => {
    const kv = await installedKv()
    const call = portal()
    let now = 1_000
    const deps = { kv, call, appCode: APP, now: () => now }
    for (let i = 0; i < VERIFY_CACHE_MAX / 2; i++) await verifyFrame({ ...auth, accessToken: `old${i}` }, deps)
    now += VERIFY_CACHE_MS
    for (let i = 0; i < VERIFY_CACHE_MAX / 2; i++) await verifyFrame({ ...auth, accessToken: `new${i}` }, deps)
    await verifyFrame({ ...auth, accessToken: 'trigger' }, deps)
    // The expired half is dropped entirely (not 10% by insertion order), the fresh half stays intact.
    expect(frameCacheSize()).toBe(VERIFY_CACHE_MAX / 2 + 1)
    const before = call.mock.calls.length
    await verifyFrame({ ...auth, accessToken: 'new0' }, deps)
    expect(call.mock.calls.length).toBe(before)
  })

  it('a re-checked token counts as fresh on eviction (order is by last check)', async () => {
    const kv = await installedKv()
    const call = portal()
    let now = 1_000
    const deps = { kv, call, appCode: APP, now: () => now }
    await verifyFrame({ ...auth, accessToken: 'active' }, deps)
    // Filler entries are inserted later but checked earlier than "active" gets re-checked.
    now += VERIFY_CACHE_MS / 2
    for (let i = 0; i < VERIFY_CACHE_MAX - 2; i++) await verifyFrame({ ...auth, accessToken: `f${i}` }, deps)
    now += VERIFY_CACHE_MS / 2
    // The "active" entry has expired — live check; now it is fresher than all filler entries.
    await verifyFrame({ ...auth, accessToken: 'active' }, deps)
    // Overflow: the entries checked longest ago are evicted — the fillers, not "active".
    await verifyFrame({ ...auth, accessToken: 'x1' }, deps)
    await verifyFrame({ ...auth, accessToken: 'x2' }, deps)
    const before = call.mock.calls.length
    await verifyFrame({ ...auth, accessToken: 'active' }, deps)
    expect(call.mock.calls.length).toBe(before)
  })

  it('isAuthRejection distinguishes rejection from failure', () => {
    expect(isAuthRejection('NO_AUTH_FOUND: Wrong authorization data')).toBe(true)
    expect(isAuthRejection('frame token rejected')).toBe(true)
    expect(isAuthRejection('503 Service Unavailable')).toBe(false)
  })
})
