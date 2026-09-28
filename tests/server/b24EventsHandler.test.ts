import { randomBytes } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { handleB24Event, type EventDeps } from '../../server/utils/b24EventsHandler'
import { accessTokenOf, getPortal, getPortalByDomain, refreshTokenOf, saveInstall, type KeyValue } from '../../server/utils/tokenStore'

function memoryKv(): KeyValue & { data: Map<string, unknown> } {
  const data = new Map<string, unknown>()
  return {
    data,
    getItem: async key => data.get(key) ?? null,
    setItem: async (key, value) => void data.set(key, value),
    removeItem: async key => void data.delete(key)
  }
}

/** Event body in the same PHP bracket-array form the portal sends it in. */
function body(event: string, auth: Record<string, string>): string {
  const form = new URLSearchParams({ event })
  for (const [k, v] of Object.entries(auth)) form.set(`auth[${k}]`, v)
  return form.toString()
}

const installAuth = {
  domain: 'demo.bitrix24.ru',
  member_id: 'm1',
  application_token: 'app-secret',
  access_token: 'sent-access',
  refresh_token: 'sent-refresh',
  expires_in: '3600',
  server_endpoint: 'https://oauth.bitrix24.tech/rest/'
}

/** OAuth server that knows one real grant: portal m1 on demo.bitrix24.ru. */
const realGrant = { access_token: 'rotated-access', refresh_token: 'rotated-refresh', expires_in: 3600, member_id: 'm1', client_endpoint: 'https://demo.bitrix24.ru/rest/' }

type TestDeps = EventDeps & { kv: ReturnType<typeof memoryKv>, lines: string[], warnings: string[] }

function deps(over: Partial<EventDeps> = {}): TestDeps {
  const lines: string[] = []
  const warnings: string[] = []
  return {
    kv: memoryKv(),
    envToken: '',
    creds: { clientId: 'cid', clientSecret: 'csecret' },
    refresh: vi.fn(async () => realGrant),
    env: {},
    log: line => lines.push(line),
    warn: line => warnings.push(line),
    ...over,
    lines,
    warnings
  } as TestDeps
}

beforeEach(() => {
  vi.stubEnv('B24_TOKEN_ENC_KEY', randomBytes(32).toString('hex'))
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('events we do not handle', () => {
  it('unrelated or empty event — 200 and nothing changes', async () => {
    const d = deps()
    expect(await handleB24Event(body('ONCRMDEALUPDATE', installAuth), d)).toEqual({ status: 200, body: { ok: true, ignored: 'ONCRMDEALUPDATE' } })
    expect(await handleB24Event('', d)).toEqual({ status: 200, body: { ok: true, ignored: 'empty' } })
    expect(d.kv.data.size).toBe(0)
  })

  it('unrelated events do NOT consume the install limit', async () => {
    const allowEvent = vi.fn(() => true)
    const d = deps({ allowEvent })
    for (let i = 0; i < 100; i++) await handleB24Event(body('ONTASKUPDATE', installAuth), d)
    expect(allowEvent).not.toHaveBeenCalled()
    expect((await handleB24Event(body('ONAPPINSTALL', installAuth), d)).status).toBe(200)
    expect(allowEvent).toHaveBeenCalledTimes(1)
  })

  it('the shared verification cap is spent only by verifications: garbage and uninstalls do not', async () => {
    const allowVerification = vi.fn(() => true)
    const d = deps({ allowVerification })
    await handleB24Event('event=ONAPPINSTALL', d)
    await handleB24Event(body('ONAPPINSTALL', { ...installAuth, domain: 'evil.com' }), d)
    await handleB24Event(body('ONAPPUNINSTALL', { domain: 'demo.bitrix24.ru', member_id: 'm1', application_token: 'x' }), d)
    await handleB24Event(body('ONAPPINSTALL', { ...installAuth, server_endpoint: 'https://evil.com/rest/' }), d)
    expect(allowVerification).not.toHaveBeenCalled()
    await handleB24Event(body('ONAPPINSTALL', installAuth), d)
    expect(allowVerification).toHaveBeenCalledTimes(1)
  })

  it('verification cap exhausted — 429 and logged as a warning, no OAuth call', async () => {
    const d = deps({ allowVerification: () => false })
    expect((await handleB24Event(body('ONAPPINSTALL', installAuth), d)).status).toBe(429)
    expect(d.refresh).not.toHaveBeenCalled()
    expect(d.warnings.join('\n')).toMatch(/verification capacity/)
  })

  it('install limit exhausted — 429, no OAuth call, nothing written', async () => {
    const d = deps({ allowEvent: () => false })
    expect(await handleB24Event(body('ONAPPINSTALL', installAuth), d)).toEqual({ status: 429, body: { error: 'too many install events' } })
    expect(d.refresh).not.toHaveBeenCalled()
    expect(d.kv.data.size).toBe(0)
  })
})

describe('install (ONAPPINSTALL)', () => {
  it('saves the ROTATED tokens and domain from the grant; no tokens in the log', async () => {
    const d = deps()
    const res = await handleB24Event(body('ONAPPINSTALL', installAuth), d)
    expect(res).toEqual({ status: 200, body: { ok: true } })
    expect(d.refresh).toHaveBeenCalledWith('sent-refresh', 'oauth.bitrix24.tech')
    const saved = (await getPortalByDomain(d.kv, 'demo.bitrix24.ru'))!
    expect(accessTokenOf(saved)).toBe('rotated-access')
    expect(refreshTokenOf(saved)).toBe('rotated-refresh')
    expect(saved.applicationToken).toBe('app-secret')
    expect(d.lines.join('\n')).not.toMatch(/access|refresh|app-secret/)
  })

  it('no auth, no member_id, or domain is not Bitrix24 — 400, no OAuth call', async () => {
    const d = deps()
    expect((await handleB24Event('event=ONAPPINSTALL', d)).status).toBe(400)
    expect((await handleB24Event(body('ONAPPINSTALL', { ...installAuth, member_id: '' }), d)).status).toBe(400)
    expect((await handleB24Event(body('ONAPPINSTALL', { ...installAuth, domain: 'evil.com' }), d)).status).toBe(400)
    expect(d.refresh).not.toHaveBeenCalled()
    expect(d.kv.data.size).toBe(0)
  })

  it('application token does not match B24_APPLICATION_TOKEN — 403', async () => {
    const d = deps({ envToken: 'expected' })
    expect((await handleB24Event(body('ONAPPINSTALL', installAuth), d)).status).toBe(403)
    expect(d.kv.data.size).toBe(0)
  })

  it('only one of B24_CLIENT_ID/SECRET is set — also 503, not an attempted verification', async () => {
    for (const creds of [{ clientId: 'cid', clientSecret: '' }, { clientId: '', clientSecret: 'cs' }]) {
      const d = deps({ creds })
      expect((await handleB24Event(body('ONAPPINSTALL', installAuth), d)).status).toBe(503)
      expect(d.refresh).not.toHaveBeenCalled()
    }
  })

  it('without B24_CLIENT_ID/SECRET the install is NOT saved — 503 (fail-closed), logged as a warning', async () => {
    const d = deps({ creds: { clientId: '', clientSecret: '' } })
    expect((await handleB24Event(body('ONAPPINSTALL', installAuth), d)).status).toBe(503)
    expect(d.refresh).not.toHaveBeenCalled()
    expect(d.kv.data.size).toBe(0)
    expect(d.warnings.join('\n')).toMatch(/B24_CLIENT_ID/)
  })

  it('auth server — the one the portal named, if allow-listed; saved with the install', async () => {
    const d = deps()
    await handleB24Event(body('ONAPPINSTALL', { ...installAuth, server_endpoint: 'https://oauth.bitrix.info/rest/' }), d)
    expect(d.refresh).toHaveBeenCalledWith('sent-refresh', 'oauth.bitrix.info')
    expect((await getPortal(d.kv, 'm1'))?.oauthHost).toBe('oauth.bitrix.info')
  })

  it('auth server not allow-listed — 403, no OAuth call, warning logged', async () => {
    const d = deps()
    const res = await handleB24Event(body('ONAPPINSTALL', { ...installAuth, server_endpoint: 'https://evil.com/rest/' }), d)
    expect(res.status).toBe(403)
    expect(d.refresh).not.toHaveBeenCalled()
    expect(d.kv.data.size).toBe(0)
    expect(d.warnings.join('\n')).toMatch(/not allow-listed/)
  })

  it('another member_id with our own grant — 403, victim record untouched', async () => {
    const d = deps()
    await saveInstall(d.kv, { memberId: 'victim', domain: 'victim.bitrix24.ru', accessToken: 'va', refreshToken: 'vr', expiresIn: 3600, applicationToken: 'vt' })
    const res = await handleB24Event(body('ONAPPINSTALL', { ...installAuth, member_id: 'victim', domain: 'victim.bitrix24.ru' }), d)
    expect(res.status).toBe(403)
    expect(accessTokenOf((await getPortal(d.kv, 'victim'))!)).toBe('va')
  })

  it('own member_id but victim domain — 403, victim domain index not hijacked', async () => {
    const d = deps()
    await saveInstall(d.kv, { memberId: 'victim', domain: 'victim.bitrix24.ru', accessToken: 'va', refreshToken: 'vr', expiresIn: 3600, applicationToken: 'vt' })
    const res = await handleB24Event(body('ONAPPINSTALL', { ...installAuth, domain: 'victim.bitrix24.ru' }), d)
    expect(res.status).toBe(403)
    expect((await getPortalByDomain(d.kv, 'victim.bitrix24.ru'))?.memberId).toBe('victim')
    expect(await getPortal(d.kv, 'm1')).toBeNull()
  })

  it('OAuth unreachable — 503, nothing saved', async () => {
    const d = deps({ refresh: async () => {
      throw new Error('ECONNRESET')
    } })
    expect((await handleB24Event(body('ONAPPINSTALL', installAuth), d)).status).toBe(503)
    expect(d.kv.data.size).toBe(0)
  })

  it('reinstall does not overwrite application_token', async () => {
    const d = deps()
    await handleB24Event(body('ONAPPINSTALL', installAuth), d)
    await handleB24Event(body('ONAPPINSTALL', { ...installAuth, application_token: 'other' }), d)
    expect((await getPortal(d.kv, 'm1'))?.applicationToken).toBe('app-secret')
  })
})

describe('uninstall (ONAPPUNINSTALL)', () => {
  const uninstall = (token: string) => body('ONAPPUNINSTALL', { domain: 'demo.bitrix24.ru', member_id: 'm1', application_token: token })

  it('correct token — record and index removed', async () => {
    const d = deps()
    await handleB24Event(body('ONAPPINSTALL', installAuth), d)
    expect(await handleB24Event(uninstall('app-secret'), d)).toEqual({ status: 200, body: { ok: true } })
    expect(d.kv.data.size).toBe(0)
  })

  it('wrong token — 403, record left in place', async () => {
    const d = deps()
    await handleB24Event(body('ONAPPINSTALL', installAuth), d)
    expect((await handleB24Event(uninstall('guess'), d)).status).toBe(403)
    expect(await getPortal(d.kv, 'm1')).not.toBeNull()
  })

  it('unknown portal and no token in the environment — 503, not "delete on say-so"', async () => {
    expect((await handleB24Event(uninstall('any'), deps())).status).toBe(503)
  })
})
