// Параметры REST-запросов сценария счёта — одно место для приложения (useInvoiceFill.ts) и
// смок-набора (smoke/): прогон на тестовом портале шлёт РОВНО те запросы, что и страница.
// Чистый модуль без SDK. Методы и их грабли — docs/REST_METHODS.md.

import { INVOICE_ENTITY_TYPE_ID, INVOICE_OWNER_TYPE } from '#shared/domain/tasks'
import type { ProductRowPayload } from '#shared/domain/fill'

/**
 * Поля задачи в tasks.task.list (REST v2). `TAGS` — теги прямо в списке
 * (`tags: { "<id>": { id, title } }`, замер 2026-09-24): решение владельца — брать их из v2, а
 * не отдельным `tasks.task.get` v3 на каждую задачу; вернуться к v3 — issue #13.
 */
export const TASK_SELECT = ['ID', 'TITLE', 'DESCRIPTION', 'RESPONSIBLE_ID', 'UF_CRM_TASK', 'TIME_SPENT_IN_LOGS', 'TAGS']

/** Страница task.elapseditem.getlist — максимум 50 (документация метода). */
export const ELAPSED_PAGE = 50
/** Потолок страниц записей времени одной задачи: 100 × 50 = 5000 записей. */
export const MAX_ELAPSED_PAGES = 100
/** Страница crm.item.productrow.list — 50 (документация метода; замер 2026-09-24). */
export const PRODUCT_ROWS_PAGE = 50
/** Потолок позиций счёта, которые читаем: 200 страниц × 50. */
export const MAX_PRODUCT_ROWS = 10_000
/** Сколько результатов задачи берём в контекст названий — последние важнее. */
export const MAX_RESULTS = 20

/** Тип объекта CRM «компания» (документация crm.item.*). */
export const COMPANY_ENTITY_TYPE_ID = 4

/** Вызов REST с именованными параметрами. */
export interface RestCall {
  method: string
  params: Record<string, unknown>
}

/** Вызов старого метода с ПОЗИЦИОННЫМИ параметрами — массивом (task.elapseditem.*). */
export interface PositionalRestCall {
  method: string
  params: unknown[]
}

/** Курсорное листание tasks.task.list в b24jssdk (`actions.v2.callList`). */
export const TASK_LIST_OPTIONS = { idKey: 'id', cursorIdKey: 'ID', customKeyForResult: 'tasks' } as const

/** Счёт: crm.item.get. */
export function invoiceGetCall(id: number): RestCall {
  return { method: 'crm.item.get', params: { entityTypeId: INVOICE_ENTITY_TYPE_ID, id } }
}

/** Страница позиций счёта: crm.item.productrow.list, листание `start` по 50. */
export function productRowListCall(invoiceId: number, start: number): RestCall {
  return {
    method: 'crm.item.productrow.list',
    params: { filter: { '=ownerType': INVOICE_OWNER_TYPE, '=ownerId': invoiceId }, order: { id: 'asc' }, start }
  }
}

/**
 * Задачи с кодом привязки: tasks.task.list. ⚠ Фильтр ОБЪЕКТОМ — форма REST v2; массив (форма v3)
 * портал отвергает с 400 (замер 2026-09-24).
 */
export function taskListCall(code: string): RestCall {
  return { method: 'tasks.task.list', params: { filter: { UF_CRM_TASK: code }, select: TASK_SELECT } }
}

/** Страница записей времени: task.elapseditem.getlist, параметры ПОЗИЦИОННЫЕ (документация). */
export function elapsedListCall(taskId: number, page: number): PositionalRestCall {
  return {
    method: 'task.elapseditem.getlist',
    params: [taskId, { ID: 'asc' }, {}, ['*'], { NAV_PARAMS: { nPageSize: ELAPSED_PAGE, iNumPage: page } }]
  }
}

/** Результаты задачи: tasks.task.result.list (REST v3), фильтр по `taskId` обязателен. */
export function resultListCall(taskId: number): RestCall {
  return {
    method: 'tasks.task.result.list',
    params: { filter: [['taskId', '=', taskId]], select: ['id', 'text'], order: { id: 'desc' }, pagination: { limit: MAX_RESULTS } }
  }
}

/** Страница crm.item.list — 50 (документация метода). */
export const MY_COMPANIES_PAGE = 50

/**
 * «Реквизиты вашей компании» — компании с признаком «моя компания»: crm.item.list, `entityTypeId = 4`,
 * фильтр `isMyCompany = Y` (документация «Счета: обзор методов и событий»). Их ID — `mycompanyId`
 * счёта, по нему выбирается ставка НДС (shared/domain/vat.ts).
 */
export function myCompaniesCall(start: number): RestCall {
  return { method: 'crm.item.list', params: { entityTypeId: COMPANY_ENTITY_TYPE_ID, filter: { isMyCompany: 'Y' }, select: ['id', 'title'], order: { id: 'asc' }, start } }
}

/** Ставки НДС портала для выбора в настройках: catalog.vat.list (активные отбирает разбор). */
export function vatListCall(): RestCall {
  return { method: 'catalog.vat.list', params: {} }
}

/** «Заменить»: crm.item.productrow.set — все позиции счёта заменяются набором. */
export function replaceRowsCall(invoiceId: number, rows: ProductRowPayload[]): RestCall {
  return { method: 'crm.item.productrow.set', params: { ownerType: INVOICE_OWNER_TYPE, ownerId: invoiceId, productRows: rows } }
}

/** «Добавить»: crm.item.productrow.add на одну позицию (пакетом с остановкой на ошибке). */
export function addRowCall(invoiceId: number, fields: ProductRowPayload): RestCall {
  return { method: 'crm.item.productrow.add', params: { fields: { ownerType: INVOICE_OWNER_TYPE, ownerId: invoiceId, ...fields } } }
}
