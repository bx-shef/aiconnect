import { randomBytes } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { decryptSecret, encryptSecret, loadEncKey } from '../../server/utils/secretCrypto'
import { accessTokenOf, getPortal, getPortalByDomain, refreshTokenOf, removePortal, saveInstall, updateTokens, type KeyValue } from '../../server/utils/tokenStore'
import { endpointHost, rawOauthRefresh, verifyInstallMember } from '../../server/utils/verifyInstallMember'

function memoryKv(): KeyValue & { data: Map<string, unknown> } {
  const data = new Map<string, unknown>()
  return {
    data,
    getItem: async key => data.get(key) ?? null,
    setItem: async (key, value) => void data.set(key, value),
    removeItem: async key => void data.delete(key)
  }
}

beforeEach(() => {
  vi.stubEnv('B24_TOKEN_ENC_KEY', randomBytes(32).toString('hex'))
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('secret encryption', () => {
  it('round-trips; a fresh ciphertext every time', () => {
    const a = encryptSecret('refresh-token')
    expect(a).not.toBe(encryptSecret('refresh-token'))
    expect(decryptSecret(a)).toBe('refresh-token')
  })

  it('a different key fails to decrypt — throws, not garbage', () => {
    const blob = encryptSecret('secret')
    expect(() => decryptSecret(blob, randomBytes(32))).toThrow()
  })

  it('no key in the environment — refuses, does not store plaintext', () => {
    expect(() => loadEncKey({})).toThrow(/not set/)
    expect(() => loadEncKey({ B24_TOKEN_ENC_KEY: 'short' })).toThrow(/32 bytes/)
  })
})

describe('install storage', () => {
  const install = { memberId: 'M1', domain: 'Demo.bitrix24.ru', accessToken: 'AT', refreshToken: 'RT', expiresIn: 3600, applicationToken: 'app1' }

  it('auth server: from the install, defaults to current', async () => {
    const kv = memoryKv()
    await saveInstall(kv, { ...install, oauthHost: 'oauth.bitrix.info' })
    expect((await getPortal(kv, 'm1'))?.oauthHost).toBe('oauth.bitrix.info')
    await saveInstall(kv, { ...install, memberId: 'M2', domain: 'b.bitrix24.ru' })
    expect((await getPortal(kv, 'm2'))?.oauthHost).toBe('oauth.bitrix24.tech')
  })

  it('saves, finds by domain, encrypts BOTH tokens', async () => {
    const kv = memoryKv()
    await saveInstall(kv, { ...install, accessToken: 'access-secret', refreshToken: 'refresh-secret' }, 1000)
    const byDomain = await getPortalByDomain(kv, 'demo.bitrix24.ru')
    expect(byDomain).toMatchObject({ memberId: 'm1', domain: 'demo.bitrix24.ru', expiresAt: 1000 + 3600_000 })
    // No token is stored as plaintext (a volume leak does not grant admin rights).
    expect(JSON.stringify([...kv.data.values()])).not.toMatch(/access-secret|refresh-secret/)
    expect(accessTokenOf(byDomain!)).toBe('access-secret')
    expect(refreshTokenOf(byDomain!)).toBe('refresh-secret')
  })

  it('encryption key changed — no tokens, not a throw', async () => {
    const kv = memoryKv()
    await saveInstall(kv, install)
    vi.stubEnv('B24_TOKEN_ENC_KEY', randomBytes(32).toString('hex'))
    const record = (await getPortal(kv, 'm1'))!
    expect(accessTokenOf(record)).toBe('')
    expect(refreshTokenOf(record)).toBe('')
  })

  it('updating tokens encrypts the new ones and does not blank refresh with an empty value', async () => {
    const kv = memoryKv()
    await saveInstall(kv, install)
    await updateTokens(kv, 'M1', { accessToken: 'AT2', refreshToken: '', expiresAt: 5 })
    const record = (await getPortal(kv, 'm1'))!
    expect(accessTokenOf(record)).toBe('AT2')
    expect(refreshTokenOf(record)).toBe('RT')
    expect(record.expiresAt).toBe(5)
  })

  it('a domain index pointing to a record with a different domain does not fire', async () => {
    const kv = memoryKv()
    await saveInstall(kv, install)
    // Stale index: the domain points to a record that now lives on a different domain.
    await kv.setItem('domain:old.bitrix24.ru', 'm1')
    expect(await getPortalByDomain(kv, 'old.bitrix24.ru')).toBeNull()
  })

  it('application_token is written once — a reinstall does not overwrite it', async () => {
    const kv = memoryKv()
    await saveInstall(kv, install)
    await saveInstall(kv, { ...install, applicationToken: 'attacker' })
    expect((await getPortal(kv, 'm1'))?.applicationToken).toBe('app1')
  })

  it('updating tokens does not resurrect a removed portal', async () => {
    const kv = memoryKv()
    await updateTokens(kv, 'ghost', { accessToken: 'x', refreshToken: 'y', expiresAt: 1 })
    expect(kv.data.size).toBe(0)
  })

  it('removal wipes both the record and the domain index', async () => {
    const kv = memoryKv()
    await saveInstall(kv, install)
    await removePortal(kv, 'M1')
    expect(kv.data.size).toBe(0)
  })

  it('a portal moving to a new domain removes the old index', async () => {
    const kv = memoryKv()
    await saveInstall(kv, install)
    await saveInstall(kv, { ...install, domain: 'new.bitrix24.ru' })
    expect(await getPortalByDomain(kv, 'demo.bitrix24.ru')).toBeNull()
    expect(await getPortalByDomain(kv, 'new.bitrix24.ru')).not.toBeNull()
  })

  it('another portal\'s domain index is left untouched: neither on move nor on removal', async () => {
    const kv = memoryKv()
    await saveInstall(kv, install)
    // The demo.* domain moved to another portal (M2), and M1 moved elsewhere.
    await saveInstall(kv, { ...install, memberId: 'M2', applicationToken: 'app2' })
    await saveInstall(kv, { ...install, domain: 'new.bitrix24.ru' })
    expect((await getPortalByDomain(kv, 'demo.bitrix24.ru'))?.memberId).toBe('m2')
    await removePortal(kv, 'M1')
    expect((await getPortalByDomain(kv, 'demo.bitrix24.ru'))?.memberId).toBe('m2')
  })
})

describe('member_id and domain verification on install', () => {
  const grant = { access_token: 'a2', refresh_token: 'r2', expires_in: 3600, member_id: 'm1', client_endpoint: 'https://demo.bitrix24.ru/rest/' }

  it('matched — returns the ROTATED grant and the real domain', async () => {
    const res = await verifyInstallMember('M1', 'Demo.bitrix24.ru', 'rt', async () => grant)
    expect(res).toEqual({ ok: true, grant: { accessToken: 'a2', refreshToken: 'r2', expiresIn: 3600, domain: 'demo.bitrix24.ru' } })
  })

  it('grant for another portal — 403 (attempt to poison the install)', async () => {
    const res = await verifyInstallMember('victim', 'demo.bitrix24.ru', 'rt', async () => ({ ...grant, member_id: 'attacker' }))
    expect(res).toEqual({ ok: false, status: 403 })
  })

  it('own member_id but ANOTHER portal\'s domain — 403 ("domain → portal" index spoofing)', async () => {
    const res = await verifyInstallMember('m1', 'victim.bitrix24.ru', 'rt', async () => grant)
    expect(res).toEqual({ ok: false, status: 403 })
  })

  it('response is missing member_id or portal address — 503, not "take it on faith"', async () => {
    const { member_id: _m, ...noMember } = grant
    const { client_endpoint: _c, ...noEndpoint } = grant
    expect(await verifyInstallMember('m1', 'demo.bitrix24.ru', 'rt', async () => noMember)).toEqual({ ok: false, status: 503 })
    expect(await verifyInstallMember('m1', 'demo.bitrix24.ru', 'rt', async () => noEndpoint)).toEqual({ ok: false, status: 503 })
    expect(await verifyInstallMember('m1', 'demo.bitrix24.ru', 'rt', async () => ({ ...grant, client_endpoint: 'not a url' }))).toEqual({ ok: false, status: 503 })
  })

  it('forged grant — 403, network or our own config failure — 503', async () => {
    const verify = (refresh: () => Promise<unknown>) => verifyInstallMember('m', 'demo.bitrix24.ru', 'rt', refresh)
    expect((await verify(async () => ({ error: 'invalid_grant' }))).status).toBe(403)
    expect((await verify(async () => ({ error: 'invalid_client' }))).status).toBe(503)
    expect((await verify(async () => {
      throw new Error('ECONNRESET')
    })).status).toBe(503)
    expect((await verify(async () => 'not json')).status).toBe(503)
  })

  it('no refresh token, member_id or domain to verify against — 403, no OAuth call', async () => {
    const refresh = vi.fn(async () => grant)
    expect((await verifyInstallMember('m1', 'demo.bitrix24.ru', '', refresh)).status).toBe(403)
    expect((await verifyInstallMember(' ', 'demo.bitrix24.ru', 'rt', refresh)).status).toBe(403)
    expect((await verifyInstallMember('m1', '', 'rt', refresh)).status).toBe(403)
    expect(refresh).not.toHaveBeenCalled()
  })

  it('lifetime: garbage or zero — defaults to one hour', async () => {
    const res = await verifyInstallMember('m1', 'demo.bitrix24.ru', 'rt', async () => ({ ...grant, expires_in: 'x' }))
    expect(res.grant?.expiresIn).toBe(3600)
  })

  it('endpointHost: lowercased host, or empty', () => {
    expect(endpointHost('https://Demo.Bitrix24.ru/rest/')).toBe('demo.bitrix24.ru')
    expect(endpointHost('')).toBe('')
    expect(endpointHost(42)).toBe('')
  })
})

describe('token refresh request', () => {
  it('POSTs a form to the portal\'s auth server; secrets are in the body, not the URL', async () => {
    const fetchFn = vi.fn(async () => ({ json: async () => ({ ok: 1 }) }))
    const refresh = rawOauthRefresh(fetchFn, { clientId: 'cid', clientSecret: 'csecret' })
    expect(await refresh('rt-1', 'oauth.bitrix.info')).toEqual({ ok: 1 })
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, { method: string, headers: Record<string, string>, body: string }]
    expect(url).toBe('https://oauth.bitrix.info/oauth/token/')
    expect(url).not.toMatch(/csecret|rt-1/)
    expect(init.method).toBe('POST')
    expect(init.headers['Content-Type']).toBe('application/x-www-form-urlencoded')
    expect(Object.fromEntries(new URLSearchParams(init.body))).toEqual({
      grant_type: 'refresh_token', client_id: 'cid', client_secret: 'csecret', refresh_token: 'rt-1'
    })
  })

  it('host with a path, port or userinfo — rejected before the request', async () => {
    const fetchFn = vi.fn()
    const refresh = rawOauthRefresh(fetchFn, { clientId: 'cid', clientSecret: 'csecret' })
    for (const host of ['evil.com/x', 'a@evil.com', 'evil.com:8080', '']) {
      await expect(refresh('rt', host)).rejects.toThrow()
    }
    expect(fetchFn).not.toHaveBeenCalled()
  })
})
