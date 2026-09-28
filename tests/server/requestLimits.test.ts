import { describe, expect, it } from 'vitest'
import { API_BODY_LIMIT, bodyLimitFor, checkBodySize, EVENTS_BODY_LIMIT, forwardedStatus, ipBucketKey, isPrivateAddress, pickClientIp } from '../../server/utils/requestLimits'

describe('bodyLimitFor', () => {
  it('portal events — 64 KB, other POSTs to /api — 512 KB', () => {
    expect(bodyLimitFor('POST', '/api/b24/events')).toBe(EVENTS_BODY_LIMIT)
    expect(bodyLimitFor('post', '/api/rates')).toBe(API_BODY_LIMIT)
  })

  it('pages and GET are unlimited (the portal POSTs to app pages)', () => {
    expect(bodyLimitFor('GET', '/api/rates')).toBeNull()
    expect(bodyLimitFor('POST', '/install')).toBeNull()
    expect(bodyLimitFor('POST', '/apiary')).toBeNull()
  })
})

describe('checkBodySize', () => {
  it('no length or garbage value — 411', () => {
    for (const v of [undefined, null, '', ' ', 'abc', '-1', '1.5']) {
      expect(checkBodySize(v, 100)).toEqual({ ok: false, status: 411 })
    }
  })

  it('exactly at the limit — allowed, one byte over — 413', () => {
    expect(checkBodySize('100', 100)).toEqual({ ok: true })
    expect(checkBodySize('101', 100)).toEqual({ ok: false, status: 413 })
    expect(checkBodySize('0', 100)).toEqual({ ok: true })
  })
})

describe('pickClientIp', () => {
  it('without a trusted proxy the header is ignored — socket address only', () => {
    expect(pickClientIp('1.1.1.1', '10.0.0.5', false)).toBe('10.0.0.5')
  })

  it('behind a proxy — the LAST address: the first was sent by the client and can be forged', () => {
    expect(pickClientIp('6.6.6.6, 203.0.113.7', '10.0.0.5', true)).toBe('203.0.113.7')
    expect(pickClientIp(' 203.0.113.7 ', '10.0.0.5', true)).toBe('203.0.113.7')
  })

  it('connection not from a private network (bypassing the proxy) — header ignored even with TRUST_PROXY', () => {
    expect(pickClientIp('1.2.3.4', '198.51.100.9', true)).toBe('198.51.100.9')
    expect(pickClientIp('1.2.3.4', '2001:db8::1', true)).toBe('2001:db8::1')
  })

  it('empty header or nothing at all — socket address or unknown', () => {
    expect(pickClientIp(', ,', '10.0.0.5', true)).toBe('10.0.0.5')
    expect(pickClientIp(undefined, undefined, true)).toBe('unknown')
  })
})

describe('isPrivateAddress', () => {
  it('private and local addresses — yes', () => {
    for (const ip of ['10.1.2.3', '127.0.0.1', '172.16.0.1', '172.31.255.254', '192.168.1.1', '169.254.1.1', '100.64.0.1', '100.127.255.255', '::1', '::ffff:10.0.0.1', '::ffff:7f00:1', '::ffff:a00:1', 'fd00::1', 'fc12:3456::1', 'fe80::1']) {
      expect(isPrivateAddress(ip), ip).toBe(true)
    }
  })

  it('public addresses and garbage — no', () => {
    for (const ip of ['8.8.8.8', '172.15.0.1', '172.32.0.1', '192.169.0.1', '100.63.0.1', '100.128.0.1', '2001:db8::1', '::ffff:8.8.8.8', 'fe00::1', '', 'unknown', '10.0.0']) {
      expect(isPrivateAddress(ip), ip).toBe(false)
    }
  })
})

describe('ipBucketKey', () => {
  it('IPv4 — the whole address (including from IPv4-mapped form)', () => {
    expect(ipBucketKey('203.0.113.7')).toBe('203.0.113.7')
    expect(ipBucketKey('::ffff:203.0.113.7')).toBe('203.0.113.7')
  })

  it('IPv6 — /64 network: iterating addresses within it gives no new keys', () => {
    expect(ipBucketKey('2001:db8:1:2::1')).toBe('2001:db8:1:2::/64')
    expect(ipBucketKey('2001:0db8:0001:0002:ffff:ffff:ffff:ffff')).toBe('2001:db8:1:2::/64')
    expect(ipBucketKey('2001:db8::1')).toBe('2001:db8:0:0::/64')
    expect(ipBucketKey('2001:db8:1:3::1')).not.toBe(ipBucketKey('2001:db8:1:2::1'))
  })
})

describe('forwardedStatus — diagnostics for /api/health', () => {
  it('used — own proxy from a private network; ignored — header present but not trusted; absent — no header', () => {
    expect(forwardedStatus('203.0.113.7', '10.0.0.5', true)).toBe('used')
    expect(forwardedStatus('203.0.113.7', '10.0.0.5', false)).toBe('ignored')
    expect(forwardedStatus('203.0.113.7', '198.51.100.9', true)).toBe('ignored')
    expect(forwardedStatus('', '10.0.0.5', true)).toBe('absent')
    expect(forwardedStatus(' , ', '10.0.0.5', true)).toBe('absent')
  })
})
