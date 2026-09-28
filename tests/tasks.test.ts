import { describe, expect, it } from 'vitest'
import { crmBindingCodes, listRows, parseTask, parseTaskTags, parseTimeEntry, tasksBoundTo } from '#shared/domain/tasks'
import { checkInvoice, invoiceChangedSince, parseInvoice, invoiceProblems } from '#shared/domain/invoice'
import { defaultSettings } from '#shared/domain/settings'

describe('разбор задач', () => {
  it('читает camelCase-ответ tasks.task.list, где числа пришли строками', () => {
    const t = parseTask({ id: '15', title: ' Задача ', responsibleId: '7', ufCrmTask: ['D_5', 'C_2'], timeSpentInLogs: '3600' })
    expect(t).toEqual({ id: 15, title: 'Задача', description: '', responsibleId: 7, crmBindings: ['D_5', 'C_2'], timeSpentInLogs: 3600, tags: [] })
  })

  it('понимает и UPPER_CASE-ключи', () => {
    expect(parseTask({ ID: '3', TITLE: 'X', RESPONSIBLE_ID: '1', UF_CRM_TASK: 'D_1' })?.crmBindings).toEqual(['D_1'])
  })

  it('теги v2 (замер: tags — объект «id → { id, title }»): имена, без пустых, мусора и дублей', () => {
    expect(parseTaskTags({ id: '2', tags: { 2: { id: 2, title: 'Срочно' }, 4: { id: 4, title: 'ЧЧ1' } } })).toEqual(['Срочно', 'ЧЧ1'])
    expect(parseTaskTags({ id: '5', tags: { 1: { id: 1, title: ' ЧЧ1 ' }, 2: { id: 2, title: '' }, 3: { id: 3, title: 'ЧЧ1' }, 6: null, 7: 'Срочно' } }))
      .toEqual(['ЧЧ1'])
  })

  it('задача без тегов (замер: tags — []), без поля или не объект — пусто', () => {
    expect(parseTaskTags({ id: '4', tags: [] })).toEqual([])
    expect(parseTaskTags({ id: '4' })).toEqual([])
    expect(parseTaskTags(null)).toEqual([])
    expect(parseTaskTags({ id: '4', tags: 'Срочно' })).toEqual([])
  })

  it('живой ответ v2 tasks.task.list (замер): числа строками, timeSpentInLogs при нуле — null', () => {
    const row = { id: '10', title: 'IFT: чужая задача', description: 'Описание', responsibleId: '1', ufCrmTask: ['D_999999'], timeSpentInLogs: null, group: [] }
    expect(parseTask(row)).toEqual({ id: 10, title: 'IFT: чужая задача', description: 'Описание', responsibleId: 1, crmBindings: ['D_999999'], timeSpentInLogs: 0, tags: [] })
  })

  it('теги приходят в том же списке v2 (select TAGS) и разбираются в parseTask', () => {
    const row = { id: '2', title: 'IFT: задача сделки с тегами', responsibleId: '1', ufCrmTask: ['D_4'], timeSpentInLogs: '5400', tags: { 2: { id: 2, title: 'Срочно' }, 4: { id: 4, title: 'ЧЧ1' } } }
    expect(parseTask(row)?.tags).toEqual(['Срочно', 'ЧЧ1'])
  })

  it('тег длиннее 100 символов отбрасывается, а не обрезается; ровно 100 — остаётся', () => {
    const exact = 'т'.repeat(100)
    expect(parseTaskTags({ tags: { 1: { id: 1, title: exact }, 2: { id: 2, title: `${exact}ы` } } })).toEqual([exact])
  })

  it('берёт строки из обёртки { tasks: [...] }', () => {
    expect(listRows({ tasks: [{ id: 1 }] }, 'tasks')).toHaveLength(1)
    expect(listRows(null, 'tasks')).toEqual([])
  })
})

describe('перепроверка привязки к CRM', () => {
  it('отбрасывает задачи, которые фильтр портала пропустил', () => {
    // Непонятый фильтр портал игнорирует и отдаёт всё — это и ловим.
    const rows = [
      { id: '1', ufCrmTask: ['D_5'] },
      { id: '2', ufCrmTask: ['D_6'] },
      { id: '3', ufCrmTask: [] },
      { id: '1', ufCrmTask: ['D_5'] }
    ]
    expect(tasksBoundTo(rows, crmBindingCodes(2, 5)).map(t => t.id)).toEqual([1])
  })

  it('для счёта ищет оба возможных кода, без учёта регистра', () => {
    expect(crmBindingCodes(31, 8)).toEqual(['SI_8', 'T1f_8'])
    expect(tasksBoundTo([{ id: '4', ufCrmTask: ['T1F_8'] }], crmBindingCodes(31, 8)).map(t => t.id)).toEqual([4])
  })
})

describe('разбор записей времени', () => {
  it('датой записи считается дата её создания, а не начала работы (решение по #3)', () => {
    const e = parseTimeEntry({ ID: '101', TASK_ID: '10', USER_ID: '7', SECONDS: '5100', COMMENT_TEXT: ' Вёрстка ', CREATED_DATE: '2026-06-05T10:00:00+03:00', DATE_START: '2026-06-01T09:00:00+03:00' })
    expect(e).toEqual({ id: 101, taskId: 10, userId: 7, seconds: 5100, comment: 'Вёрстка', date: '2026-06-05' })
  })

  it('без даты создания даты нет — дата начала её не подменяет', () => {
    expect(parseTimeEntry({ ID: '1', TASK_ID: '2', SECONDS: '60', DATE_START: '2026-06-05T10:00:00+03:00' })?.date).toBeNull()
  })

  it('запись без id или задачи отбрасывается', () => {
    expect(parseTimeEntry({ SECONDS: '60' })).toBeNull()
  })
})

describe('счёт', () => {
  it('читает crm.item.get и связь со сделкой', () => {
    const inv = parseInvoice({ item: { id: 8, title: 'Счёт №8', currencyId: 'rub', parentId2: '5', mycompanyId: '20', opportunity: '1000' } })
    expect(inv).toEqual({ id: 8, title: 'Счёт №8', currencyId: 'RUB', dealId: 5, myCompanyId: 20, opportunity: 1000 })
    // Реквизиты не выбраны — портал отдаёт 0 (замер 2026-09-26).
    expect(parseInvoice({ item: { id: 8, mycompanyId: 0 } })?.myCompanyId).toBeNull()
    expect(parseInvoice({ item: { id: 8 } })?.myCompanyId).toBeNull()
  })

  it('нет сделки или валюты ставок — останавливаемся до чтения задач; другая валюта счёта — не стоп', () => {
    const inv = parseInvoice({ item: { id: 8, currencyId: 'USD', parentId2: 0, mycompanyId: 20 } })!
    const vat = [{ companyId: 20, title: 'ООО Альфа', rate: 20 }]
    expect(invoiceProblems(inv, { ...defaultSettings(), currency: 'RUB', vat }, 'deal'))
      .toEqual(['Счёт не связан со сделкой — выберите задачи, привязанные к самому счёту'])
    expect(invoiceProblems(inv, { ...defaultSettings(), currency: 'RUB', vat }, 'invoice')).toEqual([])
    expect(invoiceProblems(inv, { ...defaultSettings(), vat }, 'invoice')).toEqual(['В настройках приложения не выбрана валюта ставок'])
  })

  it('НДС: нет реквизитов в счёте или ставки для них — стоп до чтения задач, все причины сразу', () => {
    const noCompany = parseInvoice({ item: { id: 8, parentId2: 0, mycompanyId: 0 } })!
    const problems = invoiceProblems(noCompany, { ...defaultSettings(), currency: 'RUB', vat: [{ companyId: 20, title: 'А', rate: 20 }] }, 'deal')
    expect(problems).toHaveLength(2)
    expect(problems[1]).toContain('не выбраны «Реквизиты вашей компании»')
    const unknown = parseInvoice({ item: { id: 8, mycompanyId: 21 } })!
    expect(invoiceProblems(unknown, { ...defaultSettings(), currency: 'RUB', vat: [{ companyId: 20, title: 'А', rate: 20 }] }, 'invoice'))
      .toEqual(['Для «Реквизитов вашей компании» #21 в настройках приложения не задан НДС — администратор задаёт его в «Настройки → НДС»'])
    expect(invoiceProblems(unknown, { ...defaultSettings(), currency: 'RUB', vat: [{ companyId: 21, title: '', rate: null }] }, 'invoice')).toEqual([])
  })
})

describe('счёт: одна проверка и сверка перед записью', () => {
  const base = parseInvoice({ item: { id: 8, currencyId: 'BYN', parentId2: 5, mycompanyId: 20 } })!

  it('checkInvoice отдаёт причины и ставку одним разбором — они не расходятся', () => {
    const vat = [{ companyId: 20, title: 'А', rate: 20 }]
    expect(checkInvoice(base, { ...defaultSettings(), currency: 'BYN', vat }, 'deal')).toEqual({ problems: [], vat: { ok: true, rate: 20, company: 'А' } })
    const bad = checkInvoice(base, { ...defaultSettings(), currency: 'BYN' }, 'deal')
    expect(bad.vat.ok).toBe(false)
    expect(bad.problems).toEqual([!bad.vat.ok && bad.vat.problem])
  })

  it('invoiceChangedSince: реквизиты, валюта, сделка — повод собрать заново; прочее — нет', () => {
    expect(invoiceChangedSince(base, { ...base, title: 'Новое название', opportunity: 999 })).toBeNull()
    expect(invoiceChangedSince(base, { ...base, myCompanyId: 22 })).toBe('После сбора строк в счёте изменились: «Реквизиты вашей компании» — соберите строки заново')
    expect(invoiceChangedSince(base, { ...base, myCompanyId: null, currencyId: 'USD', dealId: null }))
      .toBe('После сбора строк в счёте изменились: «Реквизиты вашей компании», валюта, сделка — соберите строки заново')
  })
})
