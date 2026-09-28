import { describe, expect, it } from 'vitest'
import { absoluteHandler, eventBindCalls, missingScopes, staleEventHandlers } from '~/utils/install'

const SITE = 'https://aiconnect.example.com'

describe('адреса обработчиков', () => {
  it('только абсолютный https', () => {
    expect(absoluteHandler(SITE, '/api/b24/events')).toBe('https://aiconnect.example.com/api/b24/events')
    expect(absoluteHandler('http://aiconnect.example.com', '/api/b24/events')).toBeNull()
    expect(absoluteHandler('', '/api/b24/events')).toBeNull()
  })
})

describe('подписки на события', () => {
  it('подписывает только недостающие', () => {
    const existing = [{ event: 'onappinstall', handler: `${SITE}/api/b24/events` }]
    expect(eventBindCalls(SITE, existing).map(c => c.params.event)).toEqual(['ONAPPUNINSTALL'])
  })

  it('без адреса приложения не подписывает ничего', () => {
    expect(eventBindCalls('', [])).toEqual([])
  })

  it('подписка на чужой адрес не считается', () => {
    const existing = [{ event: 'ONAPPINSTALL', handler: 'https://old.example.com/api/b24/events' }]
    expect(eventBindCalls(SITE, existing)).toHaveLength(2)
  })

  it('подписки со старым адресом снимаем; текущие и чужие события не трогаем', () => {
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

describe('права приложения', () => {
  it('нужны ровно ai_admin и user_brief', () => {
    expect(missingScopes(null)).toEqual(['ai_admin', 'user_brief'])
    expect(missingScopes(['user_brief'])).toEqual(['ai_admin'])
    expect(missingScopes(['ai_admin', 'user_brief', 'crm'])).toEqual([])
  })
})
