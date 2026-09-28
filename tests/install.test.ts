import { describe, expect, it } from 'vitest'
import { absoluteHandler, eventBindCalls, missingScopes, placementBindCall, staleEventHandlers, stalePlacements } from '~/utils/install'
import { invoiceIdFromOptions, invoiceIdFromQuery } from '~/utils/placement'

const SITE = 'https://invoice.example.com'

describe('адреса обработчиков', () => {
  it('только абсолютный https', () => {
    expect(absoluteHandler(SITE, '/invoice')).toBe('https://invoice.example.com/invoice')
    expect(absoluteHandler('http://invoice.example.com', '/invoice')).toBeNull()
    expect(absoluteHandler('', '/invoice')).toBeNull()
  })

  it('без адреса приложения встройку не регистрируем', () => {
    expect(placementBindCall('')).toBeNull()
    expect(placementBindCall(SITE)?.params).toMatchObject({ PLACEMENT: 'CRM_SMART_INVOICE_DETAIL_TOOLBAR', HANDLER: `${SITE}/invoice` })
  })
})

describe('подписки на события', () => {
  it('подписывает только недостающие', () => {
    const existing = [{ event: 'onappinstall', handler: `${SITE}/api/b24/events` }]
    expect(eventBindCalls(SITE, existing).map(c => c.params.event)).toEqual(['ONAPPUNINSTALL'])
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

describe('права и повторная установка', () => {
  it('показывает недостающие права', () => {
    expect(missingScopes(['crm', 'task', 'placement'])).toEqual(['catalog', 'user_brief'])
    expect(missingScopes(null)).toHaveLength(5)
  })

  it('переустановка не регистрирует второй пункт меню', () => {
    const existing = [{ placement: 'CRM_SMART_INVOICE_DETAIL_TOOLBAR', handler: `${SITE}/invoice` }]
    expect(placementBindCall(SITE, existing)).toBeNull()
  })

  it('встройку со старым адресом снимаем, новую регистрируем', () => {
    const existing = [{ placement: 'CRM_SMART_INVOICE_DETAIL_TOOLBAR', handler: 'https://old.example.com/invoice' }]
    expect(stalePlacements(SITE, existing)).toEqual([{ PLACEMENT: 'CRM_SMART_INVOICE_DETAIL_TOOLBAR', HANDLER: 'https://old.example.com/invoice' }])
    expect(placementBindCall(SITE, existing)).not.toBeNull()
  })
})

describe('контекст встройки', () => {
  it('у нового счёта ID приходит в ENTITY_ID', () => {
    expect(invoiceIdFromOptions({ ENTITY_ID: '42', URI: '/crm/type/31/details/42/' })).toBe(42)
    expect(invoiceIdFromOptions({ entity_id: 7 })).toBe(7)
    expect(invoiceIdFromOptions({ URI: '/x' })).toBeNull()
    expect(invoiceIdFromOptions(undefined)).toBeNull()
  })

  it('ID из строки запроса', () => {
    expect(invoiceIdFromQuery('12')).toBe(12)
    expect(invoiceIdFromQuery(['5', '6'])).toBe(5)
    expect(invoiceIdFromQuery('abc')).toBeNull()
  })
})
