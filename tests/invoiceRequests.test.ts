import { describe, expect, it } from 'vitest'
import {
  addRowCall,
  COMPANY_ENTITY_TYPE_ID,
  MY_COMPANIES_PAGE,
  myCompaniesCall,
  vatListCall,
  elapsedListCall,
  ELAPSED_PAGE,
  invoiceGetCall,
  MAX_RESULTS,
  productRowListCall,
  replaceRowsCall,
  resultListCall,
  TASK_SELECT,
  taskListCall
} from '~/utils/invoiceRequests'

// Формы запросов подтверждены на тестовом портале (замер 2026-09-24, docs/REST_METHODS.md):
// поломка формы — это молча пустой результат или 400, поэтому формы закреплены тестом.
describe('параметры запросов сценария счёта', () => {
  it('«Реквизиты вашей компании»: компании (тип 4) с isMyCompany = Y, id и название, листание по 50', () => {
    // Замер 2026-09-26: фильтр отбирает только «мои компании»; ответ { items: [{ id, title }] }.
    expect(myCompaniesCall(100)).toEqual({
      method: 'crm.item.list',
      params: { entityTypeId: 4, filter: { isMyCompany: 'Y' }, select: ['id', 'title'], order: { id: 'asc' }, start: 100 }
    })
    expect(COMPANY_ENTITY_TYPE_ID).toBe(4)
    expect(MY_COMPANIES_PAGE).toBe(50)
  })

  it('ставки НДС портала: catalog.vat.list без фильтра — неактивные отбирает разбор', () => {
    expect(vatListCall()).toEqual({ method: 'catalog.vat.list', params: {} })
  })

  it('задачи: фильтр ОБЪЕКТОМ по UF_CRM_TASK и теги в том же списке', () => {
    expect(taskListCall('D_4')).toEqual({ method: 'tasks.task.list', params: { filter: { UF_CRM_TASK: 'D_4' }, select: TASK_SELECT } })
    expect(TASK_SELECT).toContain('TAGS')
    expect(TASK_SELECT).toContain('UF_CRM_TASK')
  })

  it('записи времени: позиционные параметры, страница 50', () => {
    expect(elapsedListCall(7, 2)).toEqual({
      method: 'task.elapseditem.getlist',
      params: [7, { ID: 'asc' }, {}, ['*'], { NAV_PARAMS: { nPageSize: ELAPSED_PAGE, iNumPage: 2 } }]
    })
    expect(ELAPSED_PAGE).toBe(50)
  })

  it('счёт и позиции: entityTypeId 31, ownerType SI, листание start', () => {
    expect(invoiceGetCall(2)).toEqual({ method: 'crm.item.get', params: { entityTypeId: 31, id: 2 } })
    expect(productRowListCall(2, 50)).toEqual({
      method: 'crm.item.productrow.list',
      params: { filter: { '=ownerType': 'SI', '=ownerId': 2 }, order: { id: 'asc' }, start: 50 }
    })
  })

  it('результаты задачи: REST v3, фильтр тройкой по taskId', () => {
    expect(resultListCall(2)).toEqual({
      method: 'tasks.task.result.list',
      params: { filter: [['taskId', '=', 2]], select: ['id', 'text'], order: { id: 'desc' }, pagination: { limit: MAX_RESULTS } }
    })
    expect(MAX_RESULTS).toBe(20)
  })

  it('запись: set — весь набор, add — одна позиция с ownerType и ownerId', () => {
    const row = { productName: 'Вёрстка', price: 10, quantity: 1, sort: 10 }
    expect(replaceRowsCall(2, [row])).toEqual({ method: 'crm.item.productrow.set', params: { ownerType: 'SI', ownerId: 2, productRows: [row] } })
    expect(addRowCall(2, row)).toEqual({ method: 'crm.item.productrow.add', params: { fields: { ownerType: 'SI', ownerId: 2, ...row } } })
  })
})
