import { describe, expect, it } from 'vitest'
import { absoluteHandler, eventBindCalls, missingScopes, staleEventHandlers } from '~/utils/install'

const SITE = 'https://aiconnect.example.com'

describe('handler addresses', () => {
  it('absolute https only', () => {
    expect(absoluteHandler(SITE, '/api/b24/events')).toBe('https://aiconnect.example.com/api/b24/events')
    expect(absoluteHandler('http://aiconnect.example.com', '/api/b24/events')).toBeNull()
    expect(absoluteHandler('', '/api/b24/events')).toBeNull()
  })
})

describe('event subscriptions', () => {
  it('subscribes only what is missing', () => {
    const existing = [{ event: 'onappinstall', handler: `${SITE}/api/b24/events` }]
    expect(eventBindCalls(SITE, existing).map(c => c.params.event)).toEqual(['ONAPPUNINSTALL'])
  })

  it('subscribes nothing without an app address', () => {
    expect(eventBindCalls('', [])).toEqual([])
  })

  it('a subscription at another address does not count', () => {
    const existing = [{ event: 'ONAPPINSTALL', handler: 'https://old.example.com/api/b24/events' }]
    expect(eventBindCalls(SITE, existing)).toHaveLength(2)
  })

  it('removes subscriptions with a stale address; leaves current and unrelated events untouched', () => {
    const existing = [
      { event: 'onappinstall', handler: 'https://old.example.com/api/b24/events' },
      { event: 'ONAPPUNINSTALL', handler: `${SITE}/api/b24/events` },
      { event: 'ONCRMDEALADD', handler: 'https://old.example.com/x' },
      { event: 'ONAPPUNINSTALL', handler: '' }
    ]
    expect(staleEventHandlers(SITE, existing)).toEqual([{ event: 'ONAPPINSTALL', handler: 'https://old.example.com/api/b24/events' }])
    expect(staleEventHandlers('', existing)).toEqual([])
    expect(staleEventHandlers(SITE, null)).toEqual([])
  })
})

describe('application scopes', () => {
  it('needs exactly ai_admin and user_brief', () => {
    expect(missingScopes(null)).toEqual(['ai_admin', 'user_brief'])
    expect(missingScopes(['user_brief'])).toEqual(['ai_admin'])
    expect(missingScopes(['ai_admin', 'user_brief', 'crm'])).toEqual([])
  })
})
