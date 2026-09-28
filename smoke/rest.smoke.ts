// Формы запросов и ответов REST, на которых стоит приложение (docs/REST_METHODS.md, ✅).
// Каждая проверка — замер: поменяется поведение портала — проверка покраснеет раньше пользователей.

import { beforeAll, describe, expect, inject, it } from 'vitest'
import { parseCurrencies } from '#shared/domain/currency'
import { normalizeTag } from '#shared/domain/markup'
import { listRows, parseTask, parseTaskTags } from '#shared/domain/tasks'
import { parseVatRates } from '#shared/domain/vat'
import { COMPANY_ENTITY_TYPE_ID, resultListCall, TASK_SELECT, vatListCall } from '~/utils/invoiceRequests'
import { collectOffsetPages } from '~/utils/paging'
import { parseMeasures } from '~/utils/measures'
import { connectPortal, type Portal } from './lib/portal'
import { fetchEntries, listMyCompanies, readInvoice } from './lib/flow'

const env = inject('smokeEnv')
const fx = inject('fixture')

describe.skipIf(!env || !fx)('REST: формы ответов портала', () => {
  let portal: Portal
  beforeAll(() => {
    portal = connectPortal(env!.hook)
  })

  it('profile: ADMIN — логическое, ID — строка (строгая проверка `ADMIN === true` в frameAuth)', async () => {
    const p = await portal.call<{ ID?: unknown, ADMIN?: unknown }>('profile')
    expect(typeof p.ADMIN).toBe('boolean')
    expect(typeof p.ID).toBe('string')
  })

  it('crm.currency.list: есть базовая валюта, курсы разбираются', async () => {
    const list = parseCurrencies(await portal.call('crm.currency.list', {}))
    expect(list.filter(c => c.base)).toHaveLength(1)
    expect(list.find(c => c.base)?.unitRate).toBe(1)
    expect(list.length).toBeGreaterThan(1)
  })

  it('catalog.measure.list: у каждой единицы есть подпись (у системных measureTitle — null)', async () => {
    const res = await portal.call<{ measures?: unknown[] }>('catalog.measure.list', { select: ['code', 'measureTitle', 'symbol', 'symbolIntl', 'symbolLetterIntl'] })
    const measures = parseMeasures(res?.measures)
    expect(measures.length).toBeGreaterThan(0)
    for (const m of measures) expect(m.label).toMatch(/\S/)
  })

  it('catalog.vat.list: ответ { vats }, у активных ставок — число (варианты вкладки «НДС»)', async () => {
    const { method, params } = vatListCall()
    const vats = parseVatRates(await portal.call(method, params))
    expect(vats.length).toBeGreaterThan(0)
    for (const v of vats) expect(v.name).toMatch(/\S/)
  })

  it('crm.item.list isMyCompany = Y: реквизиты засева находятся, чужие компании — нет', async () => {
    const mine = new Set((await listMyCompanies(portal)).map(c => c.id))
    expect(mine.has(fx!.myCompanyId)).toBe(true)
    // Все компании портала, постранично: фильтр не должен пропустить ни одну «не мою».
    const all = await collectOffsetPages(async start => (await portal.call<{ items?: Array<Record<string, unknown>> }>('crm.item.list', {
      entityTypeId: COMPANY_ENTITY_TYPE_ID, select: ['id', 'isMyCompany'], order: { id: 'asc' }, start
    }))?.items ?? [], 50, 5000, 'слишком много компаний')
    const notMine = all.filter(c => c.isMyCompany !== 'Y').map(c => Number(c.id))
    expect(notMine.length).toBeGreaterThan(0)
    for (const id of notMine) expect(mine.has(id)).toBe(false)
  })

  it('tasks.task.list: фильтр объектом, теги в том же списке (select TAGS)', async () => {
    const res = await portal.call<{ tasks?: unknown[] }>('tasks.task.list', { filter: { UF_CRM_TASK: `D_${fx!.dealId}` }, select: TASK_SELECT })
    const tasks = listRows(res, 'tasks').map(parseTask)
    expect(tasks.map(t => t?.id).sort()).toEqual([fx!.tasks.design, fx!.tasks.plain, fx!.tasks.tiny].sort())
    // ⚠ Тег — одна запись на весь портал: уже существующий «дизайн» (любой регистр) портал подставляет
    // вместо «Дизайн» из запроса (замер 2026-09-24). Поэтому теги сравниваются без учёта регистра.
    expect(tasks.find(t => t?.id === fx!.tasks.design)?.tags.map(normalizeTag).sort()).toEqual(['дизайн', 'срочно'])
    expect(tasks.find(t => t?.id === fx!.tasks.plain)?.tags).toEqual([])
  })

  it('tasks.task.list: фильтр массивом (форма v3) — 400 «Invalid filter value»', async () => {
    await expect(portal.call('tasks.task.list', { filter: [['UF_CRM_TASK', '=', `D_${fx!.dealId}`]], select: ['ID'] })).rejects.toThrow(/Invalid filter/)
  })

  it('tasks.task.list: непонятный ключ фильтра портал игнорирует — отдаёт и чужие задачи (поэтому tasksBoundTo)', async () => {
    const res = await portal.call<{ tasks?: Array<{ id?: unknown }> }>('tasks.task.list', { filter: { UF_CRM_TASK_JUNK: 'x' }, select: ['ID'], order: { ID: 'desc' } })
    const ids = (res?.tasks ?? []).map(t => Number(t.id))
    expect(ids).toContain(fx!.tasks.foreign)
  })

  it('tasks.task.list: код привязки ищется без учёта регистра (T1F_ находит T1f_)', async () => {
    const res = await portal.call<{ tasks?: Array<{ id?: unknown }> }>('tasks.task.list', { filter: { UF_CRM_TASK: `T1F_${fx!.invoices.noDeal}` }, select: ['ID'] })
    expect((res?.tasks ?? []).map(t => Number(t.id))).toEqual([fx!.tasks.invoiceT1f])
  })

  it('task.elapseditem.getlist: 55 записей — 2 запроса, total нет, сумма секунд сходится', async () => {
    const { entries, calls } = await fetchEntries(portal, fx!.tasks.paging)
    expect(entries).toHaveLength(55)
    expect(calls).toBe(2)
    expect(entries.reduce((s, e) => s + e.seconds, 0)).toBe(60 * 55 * 56 / 2)
    const page3 = await portal.call('task.elapseditem.getlist', [fx!.tasks.paging, { ID: 'asc' }, {}, ['*'], { NAV_PARAMS: { nPageSize: 50, iNumPage: 3 } }])
    expect(listRows(page3)).toEqual([])
  })

  it('task.elapseditem.getlist: CREATED_DATE, заданная задним числом, — дата записи (решение #3)', async () => {
    const { entries } = await fetchEntries(portal, fx!.tasks.design)
    // «Сегодня» — по часовому поясу ПОРТАЛА (portalDate), поэтому сравнение не с датой машины,
    // а «после смены ставки»: иначе прогон около полуночи UTC краснел бы ложно.
    const dates = entries.map(e => e.date).sort()
    expect(dates[0]).toBe('2026-08-20')
    expect(dates[1]! >= '2026-09-01').toBe(true)
  })

  it('crm.item.productrow.list: 55 позиций — страницы по 50', async () => {
    const { rows } = await readInvoice(portal, fx!.invoices.paging)
    expect(rows).toHaveLength(55)
  })

  it('tasks.task.result.list (v3): фильтр тройкой, ответ { items }', async () => {
    const { method, params } = resultListCall(fx!.tasks.design)
    const res = await portal.callV3(method, params)
    expect(listRows(res, 'items').map(r => r.text)).toEqual(['Сверстаны главная и адаптив'])
  })

  it('tasks.task.get (v2, select TAGS): та же форма тегов, что в списке', async () => {
    const res = await portal.call<{ task?: unknown }>('tasks.task.get', { taskId: fx!.tasks.invoiceSi, select: ['ID', 'TAGS'] })
    expect(parseTaskTags(res?.task)).toEqual(['ЧЧ1'])
  })

  it('user.get пакетом: сотрудник найден, несуществующий — пустой массив, не ошибка', async () => {
    const res = await portal.batch([['user.get', { ID: fx!.userId }], ['user.get', { ID: 999_999_999 }]], false)
    expect(res.answers.map(a => a.ok)).toEqual([true, true])
    expect(res.answers[1]?.result).toEqual([])
  })

  it('app.option.get вебхуку недоступен — это проверяется только из установленного приложения', async () => {
    await expect(portal.call('app.option.get', {})).rejects.toThrow(/Application context/i)
  })
})
