// Тестовые данные прогона: у каждого прогона — СВОИ сделка, счета и задачи с меткой прогона, так
// что прогоны не мешают друг другу и старые данные не влияют на расчёт. Ничего не удаляется
// (решение владельца: тестовые данные остаются для ручного просмотра).

import { listMyCompanies } from './flow'
import type { Portal } from './portal'

/**
 * «Реквизиты вашей компании» смока — одни на все прогоны: список реквизитов в портале видят люди,
 * и сотня «моих компаний» от прогонов его бы засорила. Ищется по названию, нет — создаётся.
 */
export const SMOKE_MY_COMPANY = 'IFT smoke: реквизиты вашей компании'

/** Дата записи «задним числом» — до смены ставки 01.09 (сценарий «ставка менялась»). */
export const PAST_DATE = '2026-08-20T10:00:00+03:00'

export interface SeededEntry {
  id: number
  taskId: number
  seconds: number
  comment: string
}

export interface SmokeFixture {
  /** Метка прогона в названиях: по ней данные прогона видно в портале. */
  runTag: string
  /** Сотрудник вебхука — ответственный за задачи и автор записей времени. */
  userId: number
  dealId: number
  /** «Реквизиты вашей компании» счетов usd, base и noDeal; у paging их сняли — счёт без реквизитов. */
  myCompanyId: number
  invoices: {
    /** Счёт в USD из сделки — пересчёт из валюты ставок. */
    usd: number
    /** Счёт в валюте ставок из той же сделки — без пересчёта. */
    base: number
    /** Счёт без сделки — источник «задачи счёта». */
    noDeal: number
    /** Счёт для листания позиций (55 строк). */
    paging: number
  }
  tasks: {
    /** Сделка; теги «Дизайн», «Срочно»; запись сегодня и задним числом. */
    design: number
    /** Сделка; без тегов; длинная и короткая (10 мин) записи. */
    plain: number
    /** Сделка; одна запись 15 мин — тип 1 к ближайшему часу даёт ноль. */
    tiny: number
    /** Счёт `SI_`; тег «ЧЧ1»; одна запись. */
    invoiceSi: number
    /** Счёт `T1f_`; запись без описания. */
    invoiceT1f: number
    /** Чужая сделка — не должна попадать ни в один расчёт. */
    foreign: number
    /** Без привязки; 55 записей — листание. */
    paging: number
  }
  entries: SeededEntry[]
  /** Валюта ставок = базовая валюта портала. */
  baseCurrency: string
}

async function addItem(portal: Portal, entityTypeId: number, fields: Record<string, unknown>): Promise<number> {
  const res = await portal.call<{ item?: { id?: number } }>('crm.item.add', { entityTypeId, fields })
  const id = Number(res?.item?.id)
  if (!(id > 0)) throw new Error(`crm.item.add(${entityTypeId}) не вернул id`)
  return id
}

async function addTask(portal: Portal, fields: Record<string, unknown>): Promise<number> {
  const res = await portal.call<{ task?: { id?: unknown } }>('tasks.task.add', { fields: { ALLOW_TIME_TRACKING: 'Y', ...fields } })
  const id = Number(res?.task?.id)
  if (!(id > 0)) throw new Error('tasks.task.add не вернул id')
  return id
}

async function smokeMyCompany(portal: Portal): Promise<number> {
  // Весь список, а не первая страница: иначе на портале с 50+ реквизитами каждый прогон создавал бы новые.
  const found = (await listMyCompanies(portal)).find(c => c.title === SMOKE_MY_COMPANY)
  return found?.id ?? addItem(portal, 4, { title: SMOKE_MY_COMPANY, isMyCompany: 'Y' })
}

/** Создаёт данные прогона. Порядок вызовов — последовательный: портал выравнивает лимиты сам. */
export async function seed(portal: Portal): Promise<SmokeFixture> {
  // До секунды: два прогона в одну минуту в портале должны различаться на глаз.
  const runTag = `IFT smoke ${new Date().toISOString().slice(0, 19).replace('T', ' ')}`
  const profile = await portal.call<{ ID?: unknown }>('profile')
  const userId = Number(profile?.ID)
  const currencies = await portal.call<Array<{ CURRENCY?: string, BASE?: string }>>('crm.currency.list', {})
  const baseCurrency = currencies.find(c => c.BASE === 'Y')?.CURRENCY ?? ''
  if (!(userId > 0) || !baseCurrency) throw new Error('profile или базовая валюта портала не прочитаны')
  const foreignCurrency = currencies.find(c => c.BASE !== 'Y' && c.CURRENCY === 'USD')?.CURRENCY
    ?? currencies.find(c => c.BASE !== 'Y')?.CURRENCY
  if (!foreignCurrency) throw new Error('в портале нет второй валюты — пересчёт не проверить')

  const dealId = await addItem(portal, 2, { title: `${runTag}: сделка`, currencyId: baseCurrency })
  const myCompanyId = await smokeMyCompany(portal)
  const invoices = {
    usd: await addItem(portal, 31, { title: `${runTag}: счёт ${foreignCurrency}`, parentId2: dealId, currencyId: foreignCurrency, mycompanyId: myCompanyId }),
    base: await addItem(portal, 31, { title: `${runTag}: счёт ${baseCurrency}`, parentId2: dealId, currencyId: baseCurrency, mycompanyId: myCompanyId }),
    noDeal: await addItem(portal, 31, { title: `${runTag}: счёт без сделки`, currencyId: baseCurrency, mycompanyId: myCompanyId }),
    paging: await addItem(portal, 31, { title: `${runTag}: листание позиций`, currencyId: baseCurrency })
  }
  // Новый счёт портал сам получает «моей компанией» по умолчанию, даже с `mycompanyId: 0` в
  // crm.item.add (замер 2026-09-26); снять реквизиты можно только crm.item.update.
  await portal.call('crm.item.update', { entityTypeId: 31, id: invoices.paging, fields: { mycompanyId: 0 } })
  const base = { RESPONSIBLE_ID: userId }
  const tasks = {
    design: await addTask(portal, { ...base, TITLE: `${runTag}: дизайн лендинга`, DESCRIPTION: 'Макет в Figma, адаптив', UF_CRM_TASK: [`D_${dealId}`], TAGS: ['Дизайн', 'Срочно'] }),
    plain: await addTask(portal, { ...base, TITLE: `${runTag}: настройка сервера`, DESCRIPTION: 'Сервер и домен', UF_CRM_TASK: [`D_${dealId}`] }),
    tiny: await addTask(portal, { ...base, TITLE: `${runTag}: звонок клиенту`, UF_CRM_TASK: [`D_${dealId}`] }),
    invoiceSi: await addTask(portal, { ...base, TITLE: `${runTag}: консультация (SI_)`, UF_CRM_TASK: [`SI_${invoices.noDeal}`], TAGS: ['ЧЧ1'] }),
    invoiceT1f: await addTask(portal, { ...base, TITLE: `${runTag}: доработка (T1f_)`, UF_CRM_TASK: [`T1f_${invoices.noDeal}`] }),
    foreign: await addTask(portal, { ...base, TITLE: `${runTag}: чужая задача`, UF_CRM_TASK: ['D_999999999'] }),
    paging: await addTask(portal, { ...base, TITLE: `${runTag}: 55 записей` })
  }

  const plan: Array<[number, Record<string, unknown>]> = [
    [tasks.design, { SECONDS: 3600, COMMENT_TEXT: 'Макет главной страницы' }],
    [tasks.design, { SECONDS: 1800, COMMENT_TEXT: 'Правки по макету', CREATED_DATE: PAST_DATE }],
    [tasks.plain, { SECONDS: 5400, COMMENT_TEXT: 'Настройка сервера' }],
    [tasks.plain, { SECONDS: 600, COMMENT_TEXT: 'Короткая правка' }],
    [tasks.tiny, { SECONDS: 900, COMMENT_TEXT: 'Звонок клиенту' }],
    [tasks.invoiceSi, { SECONDS: 2700, COMMENT_TEXT: 'Консультация клиента' }],
    [tasks.invoiceT1f, { SECONDS: 7200, COMMENT_TEXT: '' }]
  ]
  const entries: SeededEntry[] = []
  for (const [taskId, fields] of plan) {
    const id = Number(await portal.call('task.elapseditem.add', [taskId, fields]))
    entries.push({ id, taskId, seconds: Number(fields.SECONDS), comment: String(fields.COMMENT_TEXT) })
  }
  // 55 записей пакетами: минута, две, … — сумма известна заранее.
  const many = Array.from({ length: 55 }, (_, i): [string, unknown[]] => ['task.elapseditem.add', [tasks.paging, { SECONDS: 60 * (i + 1), COMMENT_TEXT: `Запись ${i + 1}` }]])
  for (let i = 0; i < many.length; i += 50) {
    const res = await portal.batch(many.slice(i, i + 50), true)
    if (!res.ok) throw new Error(`task.elapseditem.add пакетом: ${res.errors.join('; ')}`)
  }
  await portal.callV3('tasks.task.result.add', { fields: { taskId: tasks.design, text: 'Сверстаны главная и адаптив' } })
  await portal.call('crm.item.productrow.set', {
    ownerType: 'SI',
    ownerId: invoices.paging,
    productRows: Array.from({ length: 55 }, (_, i) => ({ productName: `${runTag}: строка ${i + 1}`, price: 1, quantity: 1, sort: (i + 1) * 10 }))
  })
  return { runTag, userId, dealId, myCompanyId, invoices, tasks, entries, baseCurrency }
}
