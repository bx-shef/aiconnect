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

/** Портал отвечает как настоящий: `profile` — сотрудник, `app.info` — наше приложение. */
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
  it('берёт Bearer-токен и домен (в том числе с протоколом, как отдаёт SDK)', () => {
    expect(extractFrameAuth(headers({ 'authorization': 'Bearer tok', 'x-b24-domain': 'https://demo.bitrix24.ru' }), {}))
      .toEqual({ domain: 'demo.bitrix24.ru', accessToken: 'tok' })
  })

  it('чужой домен, нет токена или не Bearer — null', () => {
    expect(extractFrameAuth(headers({ 'authorization': 'Bearer tok', 'x-b24-domain': 'evil.com' }), {})).toBeNull()
    expect(extractFrameAuth(headers({ 'x-b24-domain': 'demo.bitrix24.ru' }), {})).toBeNull()
    expect(extractFrameAuth(headers({ 'authorization': 'Basic tok', 'x-b24-domain': 'demo.bitrix24.ru' }), {})).toBeNull()
  })
})

describe('verifyFrame', () => {
  const auth = { domain: 'demo.bitrix24.ru', accessToken: 'tok' }

  it('без B24_APP_CODE — 503, а не пропуск проверки; в портал не ходим', async () => {
    const call = portal()
    const res = await verifyFrame(auth, { kv: await installedKv(), call, appCode: '' })
    expect(res).toMatchObject({ ok: false, status: 503 })
    expect(call).not.toHaveBeenCalled()
  })

  it('портал без установки — 409, в портал даже не ходим', async () => {
    const call = portal()
    const res = await verifyFrame(auth, { kv: memoryKv(), call, appCode: APP })
    expect(res).toMatchObject({ ok: false, status: 409 })
    expect(call).not.toHaveBeenCalled()
  })

  it('пользователь и признак администратора — из profile', async () => {
    const res = await verifyFrame(auth, { kv: await installedKv(), call: portal({ ID: '7', ADMIN: true }), appCode: APP })
    expect(res).toMatchObject({ ok: true, user: { userId: 7, isAdmin: true } })
  })

  it('ADMIN строкой "true" — не администратор (строгая проверка)', async () => {
    const res = await verifyFrame(auth, { kv: await installedKv(), call: portal({ ID: '7', ADMIN: 'true' }), appCode: APP })
    expect(res).toMatchObject({ ok: true, user: { isAdmin: false } })
  })

  it('profile без сотрудника — 401', async () => {
    expect(await verifyFrame(auth, { kv: await installedKv(), call: portal({}), appCode: APP })).toMatchObject({ ok: false, status: 401 })
  })

  it('токен чужого приложения на том же портале — 403', async () => {
    const deps: VerifyDeps = { kv: await installedKv(), appCode: APP, call: portal({ ID: 7 }, 'local.other') }
    expect(await verifyFrame(auth, deps)).toMatchObject({ ok: false, status: 403 })
  })

  it('исчерпан лимит живых проверок — 429 и в портал не ходим; решение из кэша лимит не тратит', async () => {
    const kv = await installedKv()
    const call = portal()
    expect(await verifyFrame(auth, { kv, call, appCode: APP, allowLiveCheck: () => false })).toMatchObject({ ok: false, status: 429 })
    expect(call).not.toHaveBeenCalled()
    const allow = vi.fn(() => true)
    await verifyFrame(auth, { kv, call, appCode: APP, allowLiveCheck: allow })
    await verifyFrame(auth, { kv, call, appCode: APP, allowLiveCheck: () => false })
    expect(allow).toHaveBeenCalledTimes(1)
  })

  it('отвергнутый токен — 401, сбой портала — 502', async () => {
    const kv = await installedKv()
    expect(await verifyFrame(auth, { kv, appCode: APP, call: async () => {
      throw new Error('expired_token: The access token provided has expired')
    } })).toMatchObject({ status: 401 })
    resetFrameCache()
    expect(await verifyFrame(auth, { kv, appCode: APP, call: async () => {
      throw new Error('ECONNRESET')
    } })).toMatchObject({ status: 502 })
  })

  it('сбой портала не кэшируется: следующий запрос проверяет заново', async () => {
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

  it('кэширует решение по токену ровно на VERIFY_CACHE_MS', async () => {
    const call = portal()
    const kv = await installedKv()
    let now = 1_000
    const deps = { kv, call, appCode: APP, now: () => now }
    await verifyFrame(auth, deps)
    now += VERIFY_CACHE_MS - 1
    await verifyFrame(auth, deps)
    // Два вызова на проверку (profile + app.info), и только одна проверка.
    expect(call).toHaveBeenCalledTimes(2)
    now += 1
    await verifyFrame(auth, deps)
    expect(call).toHaveBeenCalledTimes(4)
  })

  it('переполнение кэша вытесняет старые записи, а не сбрасывает всё', async () => {
    const kv = await installedKv()
    const call = portal()
    const deps = { kv, call, appCode: APP, now: () => 1_000 }
    for (let i = 0; i < VERIFY_CACHE_MAX + 1; i++) await verifyFrame({ ...auth, accessToken: `t${i}` }, deps)
    const before = call.mock.calls.length
    // Свежие токены, записанные ДО переполнения, всё ещё в кэше — полного сброса не было.
    await verifyFrame({ ...auth, accessToken: `t${VERIFY_CACHE_MAX - 1}` }, deps)
    await verifyFrame({ ...auth, accessToken: `t${VERIFY_CACHE_MAX}` }, deps)
    expect(call.mock.calls.length).toBe(before)
    // Самый старый вытеснен — проверяется заново.
    await verifyFrame({ ...auth, accessToken: 't0' }, deps)
    expect(call.mock.calls.length).toBe(before + 2)
  })

  it('при переполнении сначала снимаются ВСЕ истёкшие записи, свежие не трогаются', async () => {
    const kv = await installedKv()
    const call = portal()
    let now = 1_000
    const deps = { kv, call, appCode: APP, now: () => now }
    for (let i = 0; i < VERIFY_CACHE_MAX / 2; i++) await verifyFrame({ ...auth, accessToken: `old${i}` }, deps)
    now += VERIFY_CACHE_MS
    for (let i = 0; i < VERIFY_CACHE_MAX / 2; i++) await verifyFrame({ ...auth, accessToken: `new${i}` }, deps)
    await verifyFrame({ ...auth, accessToken: 'trigger' }, deps)
    // Истёкшая половина снята целиком (а не 10 % по порядку вставки), свежая — вся на месте.
    expect(frameCacheSize()).toBe(VERIFY_CACHE_MAX / 2 + 1)
    const before = call.mock.calls.length
    await verifyFrame({ ...auth, accessToken: 'new0' }, deps)
    expect(call.mock.calls.length).toBe(before)
  })

  it('перепроверенный токен считается свежим при вытеснении (порядок — по последней проверке)', async () => {
    const kv = await installedKv()
    const call = portal()
    let now = 1_000
    const deps = { kv, call, appCode: APP, now: () => now }
    await verifyFrame({ ...auth, accessToken: 'active' }, deps)
    // Наполнители вставлены позже, но проверены раньше, чем «active» будет перепроверен.
    now += VERIFY_CACHE_MS / 2
    for (let i = 0; i < VERIFY_CACHE_MAX - 2; i++) await verifyFrame({ ...auth, accessToken: `f${i}` }, deps)
    now += VERIFY_CACHE_MS / 2
    // Запись «active» истекла — живая проверка; теперь он свежее всех наполнителей.
    await verifyFrame({ ...auth, accessToken: 'active' }, deps)
    // Переполнение: вытесняются самые давно проверенные — наполнители, а не «active».
    await verifyFrame({ ...auth, accessToken: 'x1' }, deps)
    await verifyFrame({ ...auth, accessToken: 'x2' }, deps)
    const before = call.mock.calls.length
    await verifyFrame({ ...auth, accessToken: 'active' }, deps)
    expect(call.mock.calls.length).toBe(before)
  })

  it('isAuthRejection отличает отказ от сбоя', () => {
    expect(isAuthRejection('NO_AUTH_FOUND: Wrong authorization data')).toBe(true)
    expect(isAuthRejection('frame token rejected')).toBe(true)
    expect(isAuthRejection('503 Service Unavailable')).toBe(false)
  })
})
