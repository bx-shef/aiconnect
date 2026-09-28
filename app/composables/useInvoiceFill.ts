// Сценарий страницы счёта: прочитать счёт → найти задачи → прочитать время, теги, курс валюты →
// собрать строки (shared/domain/fill.ts) → показать → записать. Все чтения и записи в CRM идут
// ПРАВАМИ СОТРУДНИКА через фрейм: видит только свои задачи, пишет только в доступный ему счёт.
// Методы и их поля — docs/REST_METHODS.md; методы задач, которые есть в REST v3, — через v3.

import { buildConsultActivity } from '#shared/domain/activity'
import { currencyConversion, needsConversion, parseCurrencies, type CurrencyConversion } from '#shared/domain/currency'
import { applyNames, buildRows, toProductRows, type FillMode, type FillResult, type TaskSource } from '#shared/domain/fill'
import { checkInvoice, invoiceChangedSince, parseExistingRows, parseInvoice, type ExistingRow, type InvoiceInfo } from '#shared/domain/invoice'
import { clipNamingItem, fitConsultContext, MAX_NAMING_ITEMS, type NamingItem } from '#shared/domain/prompts'
import {
  crmBindingCodes,
  DEAL_ENTITY_TYPE_ID,
  INVOICE_ENTITY_TYPE_ID,
  listRows,
  parseTimeEntry,
  tasksBoundTo,
  type TaskInfo,
  type TimeEntry
} from '#shared/domain/tasks'
import { vatTotals, type VatRate } from '#shared/domain/vat'
import { B24CallError, type BatchCall } from '~/utils/b24Batch'
import { chunk, mapLimit } from '~/utils/concurrency'
import {
  addRowCall,
  elapsedListCall,
  ELAPSED_PAGE,
  invoiceGetCall,
  MAX_ELAPSED_PAGES,
  MAX_PRODUCT_ROWS,
  productRowListCall,
  PRODUCT_ROWS_PAGE,
  replaceRowsCall,
  resultListCall,
  TASK_LIST_OPTIONS,
  taskListCall
} from '~/utils/invoiceRequests'
import { collectNumberedPages, collectOffsetPages } from '~/utils/paging'
import { describeWrite, type WriteMode } from '~/utils/writeOutcome'

/** Предел названия счёта в контексте консультации — название не должно съесть весь контекст. */
const MAX_CONSULT_TITLE = 500
/** Сколько задач читаем одновременно: SDK всё равно выравнивает вызовы под лимит REST портала. */
const READ_CONCURRENCY = 4

type Step = 'idle' | 'loading' | 'collecting' | 'preview' | 'writing' | 'done'

export function useInvoiceFill() {
  const b24 = useB24()
  const { post } = useApi()
  const { settings, rates, userId } = useAppSettings()
  const users = useUsers()

  const invoice = ref<InvoiceInfo | null>(null)
  const existing = ref<ExistingRow[]>([])
  const tasks = ref<TaskInfo[]>([])
  const result = ref<FillResult | null>(null)
  /** Проблемы уровня счёта/настроек (валюта, нет сделки) — до чтения задач. */
  const problems = ref<string[]>([])
  /** Пересчёт в валюту счёта последней сборки: его предупреждение показываем и после записи. */
  const conversion = ref<CurrencyConversion | null>(null)
  /** НДС последней сборки: ставка и чьи это реквизиты — для предпросмотра. */
  const vat = ref<{ rate: VatRate, company: string } | null>(null)
  /** Счёт, по которому собраны строки: перед записью сверяемся, не поменяли ли его в карточке. */
  const collectedFrom = ref<InvoiceInfo | null>(null)
  const step = ref<Step>('idle')
  const error = ref('')
  /** Итог записи: что сказать сотруднику после «Заменить» / «Добавить» (writeOutcome.ts). */
  const notice = ref('')
  /** Какая запись идёт сейчас — чтобы индикатор крутился на нажатой кнопке, а не на соседней. */
  const writing = ref<WriteMode | null>(null)

  const canWrite = computed(() => step.value === 'preview' && !!result.value && result.value.errors.length === 0 && result.value.rows.length > 0)
  /** Итоги предпросмотра — как их посчитает портал после записи (vatTotals). */
  const totals = computed(() => vatTotals(result.value?.rows ?? []))

  /**
   * Все позиции счёта, постранично (paging.ts, покрыт тестом): у счёта их может быть больше
   * страницы. Упёрлись в потолок — ошибка, а не тихо неполный список: по нему считается порядок
   * новых строк и итог записи.
   */
  async function fetchExistingRows(id: number): Promise<ExistingRow[]> {
    const raw = await collectOffsetPages(
      async (start) => {
        const { method, params } = productRowListCall(id, start)
        return (await b24.call<{ productRows?: unknown[] }>(method, params))?.productRows ?? []
      },
      PRODUCT_ROWS_PAGE,
      MAX_PRODUCT_ROWS,
      `в счёте #${id} больше ${MAX_PRODUCT_ROWS} позиций — такой счёт приложение не обрабатывает`
    )
    return parseExistingRows(raw)
  }

  /** Счёт и его позиции. Состояние шага не трогает — это делают вызывающие. */
  async function readInvoice(id: number): Promise<void> {
    const get = invoiceGetCall(id)
    const [item, rows] = await Promise.all([
      b24.call(get.method, get.params),
      fetchExistingRows(id)
    ])
    const parsed = parseInvoice(item)
    if (!parsed) throw new Error(`Счёт #${id} не найден или нет доступа`)
    invoice.value = parsed
    existing.value = rows
  }

  async function loadInvoice(id: number): Promise<void> {
    step.value = 'loading'
    error.value = ''
    try {
      await readInvoice(id)
    } catch (e) {
      error.value = e instanceof Error ? e.message : String(e)
    } finally {
      step.value = 'idle'
    }
  }

  /** Сбросить предпросмотр: сменили источник или тип — старые строки к новым настройкам не относятся. */
  function reset(): void {
    if (step.value === 'collecting' || step.value === 'writing') return
    result.value = null
    problems.value = []
    notice.value = ''
    conversion.value = null
    vat.value = null
    step.value = 'idle'
  }

  /** Задачи по привязке. Ищем по каждому коду и перепроверяем привязку сами (tasks.ts). */
  async function fetchTasks(source: TaskSource, inv: InvoiceInfo): Promise<TaskInfo[]> {
    const codes = source === 'deal'
      ? crmBindingCodes(DEAL_ENTITY_TYPE_ID, inv.dealId!)
      : crmBindingCodes(INVOICE_ENTITY_TYPE_ID, inv.id)
    const rows: Record<string, unknown>[] = []
    for (const code of codes) {
      // Теги приходят в этом же списке (TASK_SELECT → TAGS), отдельных запросов нет.
      const { method, params } = taskListCall(code)
      rows.push(...await b24.callList<Record<string, unknown>>(method, params, { ...TASK_LIST_OPTIONS }))
    }
    return tasksBoundTo(rows, codes)
  }

  /**
   * Все записи времени задачи, постранично (paging.ts, покрыт тестом). Параметры — позиционные,
   * как в примере документации. Конец — по СЫРЫМ строкам и `total`, потолок — ошибка, а не тихо
   * неполная сумма. Записи дедуплицируются по ID: если старый метод отдаст страницу повторно,
   * время не задвоится.
   */
  async function fetchEntries(taskId: number): Promise<TimeEntry[]> {
    const raw = await collectNumberedPages(
      async (page) => {
        const { method, params } = elapsedListCall(taskId, page)
        const res = await b24.getOrThrow().actions.v2.call.make({ method, params: params as unknown as Record<string, unknown> })
        if (!res.isSuccess) throw new B24CallError(method, res.getErrorMessages())
        // getTotal() без поля `total` в ответе даёт 0 — collectNumberedPages считает это «неизвестно».
        return { rows: listRows(res.getData()?.result), total: res.getTotal() }
      },
      ELAPSED_PAGE,
      MAX_ELAPSED_PAGES,
      `в задаче #${taskId} больше ${MAX_ELAPSED_PAGES * ELAPSED_PAGE} записей времени — такой объём приложение не считает`,
      row => (row as { ID?: unknown }).ID
    )
    const byId = new Map<number, TimeEntry>()
    for (const row of raw) {
      const entry = parseTimeEntry(row)
      if (entry) byId.set(entry.id, entry)
    }
    return [...byId.values()]
  }

  /**
   * Отчёты (результаты) задачи — контекст для названий в режиме ИИ. REST v3: фильтр по `taskId`
   * обязателен (документация метода). Не обязательны: сбой не останавливает.
   */
  async function fetchResults(taskId: number): Promise<string> {
    try {
      const { method, params } = resultListCall(taskId)
      const res = await b24.callV3<unknown>(method, params)
      return listRows(res, 'items', 'results').map(r => String(r.text ?? r.TEXT ?? '')).filter(Boolean).join('\n')
    } catch {
      return ''
    }
  }

  /**
   * Пересчёт в валюту счёта (решение по #3): валюты совпадают — `null`; курса нет — исключение
   * с понятной причиной, и счёт не заполняется.
   */
  async function conversionFor(inv: InvoiceInfo): Promise<CurrencyConversion | null> {
    const from = settings.value.currency
    if (!needsConversion(from, inv.currencyId)) return null
    const res = currencyConversion(from, inv.currencyId, parseCurrencies(await b24.call<unknown>('crm.currency.list', {})))
    if (!res.ok) throw new Error(res.problem)
    return res.conversion
  }

  async function collect(source: TaskSource, mode: FillMode): Promise<void> {
    const opened = invoice.value
    if (!opened) return
    step.value = 'collecting'
    error.value = ''
    notice.value = ''
    result.value = null
    conversion.value = null
    vat.value = null
    // Счёт перечитываем: окно могло быть открыто давно, а реквизиты (ставка НДС), валюту или сделку
    // за это время поменяли в карточке — строки и запись должны идти по счёту как он есть сейчас.
    try {
      await readInvoice(opened.id)
    } catch (e) {
      error.value = e instanceof Error ? e.message : String(e)
      step.value = 'idle'
      return
    }
    const inv = invoice.value ?? opened
    const check = checkInvoice(inv, settings.value, source)
    problems.value = check.problems
    if (!problems.value.length) {
      try {
        conversion.value = await conversionFor(inv)
      } catch (e) {
        problems.value = [e instanceof Error ? e.message : String(e)]
      }
    }
    // Нет ставки НДС — это уже причина в problems; проверка `ok` здесь только сужает тип.
    const vatChoice = check.vat
    if (problems.value.length || !vatChoice.ok) {
      step.value = 'idle'
      return
    }
    vat.value = { rate: vatChoice.rate, company: vatChoice.company }
    collectedFrom.value = inv
    try {
      tasks.value = await fetchTasks(source, inv)
      const entries = (await mapLimit(tasks.value, READ_CONCURRENCY, task => fetchEntries(task.id))).flat()

      const involved = new Set<number>()
      tasks.value.forEach(t => t.responsibleId && involved.add(t.responsibleId))
      entries.forEach(e => e.userId && involved.add(e.userId))
      await users.load([...involved])
      const userNames = new Map(Object.entries(users.names.value).map(([id, name]) => [Number(id), name]))

      let built = buildRows({
        mode,
        tasks: tasks.value,
        entries,
        rates: rates.value,
        settings: settings.value,
        conversion: conversion.value,
        vatRate: vatChoice.rate,
        userNames
      })

      if (settings.value.naming === 'ai' && built.errors.length === 0 && built.rows.length > 0) {
        const names: Record<string, string> = {}
        // Пакетами по MAX_NAMING_ITEMS: сервер больше за раз не примет (бюджет модели).
        for (const part of chunk(await namingItems(mode, built), MAX_NAMING_ITEMS)) {
          const res = await post<{ names: Record<string, string> }>('/api/ai/names', { mode, items: part })
          Object.assign(names, res.names)
        }
        const named = applyNames(built.rows, names)
        built = { ...built, rows: named.rows, errors: named.errors }
      }
      result.value = built
      step.value = 'preview'
    } catch (e) {
      error.value = e instanceof Error ? e.message : String(e)
      step.value = 'idle'
    }
  }

  async function namingItems(mode: FillMode, built: FillResult): Promise<NamingItem[]> {
    const byTask = new Map(tasks.value.map(t => [t.id, t]))
    // Урезаем до отправки — как урежет сервер (clipNamingItem): тело запроса ограничено.
    if (mode === 'time') {
      return built.rows.map(r => clipNamingItem({ key: r.key, title: byTask.get(r.taskId)?.title ?? '', text: r.name }))
    }
    return mapLimit(built.rows, READ_CONCURRENCY, async (r) => {
      const task = byTask.get(r.taskId)
      return clipNamingItem({ key: r.key, title: task?.title ?? r.name, text: task?.description ?? '', result: await fetchResults(r.taskId) })
    })
  }

  /**
   * Запись в счёт.
   * • «Заменить» — один вызов crm.item.productrow.set: все позиции заменяются набором.
   * • «Добавить» — crm.item.productrow.add по одной строке: set с неполными полями обнулил бы
   *   цены существующих строк («Если не передана, цена будет равна 0» — документация).
   *   ⚠ Пакет add не транзакция: при ошибке посередине часть строк уже добавлена. Поэтому пакет
   *   останавливается на первой ошибке.
   * Автоматических повторов SDK при сетевых сбоях нет (config/b24.ts → sdkRestrictionParams), а
   * итог определяется по ПЕРЕЧИТАННОМУ счёту (writeOutcome.ts, покрыт тестом): сколько добавилось,
   * нет ли лишних строк, можно ли повторять.
   */
  async function write(replace: boolean): Promise<void> {
    const inv = invoice.value
    if (!inv || !canWrite.value || !result.value) return
    const mode: WriteMode = replace ? 'replace' : 'append'
    step.value = 'writing'
    writing.value = mode
    error.value = ''
    notice.value = ''
    // Перечитываем счёт перед записью: реквизиты (ставка НДС), валюту или сделку могли сменить в
    // карточке, пока смотрели предпросмотр, — тогда строки не те, и писать их нельзя.
    let stale: string | null
    try {
      await readInvoice(inv.id)
      stale = collectedFrom.value && invoice.value ? invoiceChangedSince(collectedFrom.value, invoice.value) : null
    } catch (e) {
      stale = e instanceof Error ? e.message : String(e)
    }
    if (stale) {
      writing.value = null
      error.value = stale
      result.value = null
      step.value = 'idle'
      return
    }
    const draft = result.value.rows
    const before = existing.value.length
    const planned = draft.length
    let failure: string | null = null
    try {
      if (replace) {
        const { method, params } = replaceRowsCall(inv.id, toProductRows(draft, settings.value))
        await b24.call(method, params)
      } else {
        const sortStart = existing.value.reduce((max, r) => Math.max(max, r.sort), 0)
        const rows = toProductRows(draft, settings.value, sortStart)
        const calls = rows.map((fields): BatchCall => {
          const { method, params } = addRowCall(inv.id, fields)
          return [method, params]
        })
        await b24.batch(calls, { haltOnError: true })
      }
    } catch (e) {
      failure = e instanceof Error ? e.message : String(e)
    }
    const after = await readInvoice(inv.id).then(() => existing.value.length, () => null)
    const verdict = describeWrite({ mode, planned, before, after, error: failure })
    writing.value = null
    if (verdict.resetPreview) result.value = null
    if (verdict.kind === 'error') {
      error.value = verdict.message
      step.value = result.value ? 'preview' : 'idle'
      return
    }
    notice.value = verdict.kind === 'warn' ? verdict.message : ''
    step.value = 'done'
  }

  /**
   * Консультация: ответ BitrixGPT по промпту из настроек → закрытое дело в счёте (activity.ts).
   * Запись в ленту не удалась — ответ всё равно возвращаем (он уже получен и оплачен лимитом),
   * с причиной в `notSaved`: сотрудник увидит ответ и узнает, что в ленте его нет.
   */
  async function consult(promptId: string): Promise<{ title: string, text: string, notSaved?: string }> {
    const inv = invoice.value
    if (!inv) throw new Error('Счёт не загружен')
    // Урезаем до того, что сервер отдаст модели: большой счёт иначе упёрся бы в предел тела запроса.
    const context = fitConsultContext({
      invoice: { title: inv.title.slice(0, MAX_CONSULT_TITLE), currency: inv.currencyId, amount: inv.opportunity },
      rows: existing.value.map(r => ({ name: r.productName, quantity: r.quantity, price: r.price })),
      tasks: tasks.value.map(t => ({ id: t.id, title: t.title, description: t.description.slice(0, 1000), hours: Math.round(t.timeSpentInLogs / 36) / 100 }))
    })
    const answer = await post<{ title: string, text: string }>('/api/ai/consult', { promptId, context })
    // Одна закрытая запись в ленте в виде ответа ИИ (activity.ts). Только из фрейма: вебхук этот
    // метод не принимает, и дело пишется правами сотрудника.
    const activity = buildConsultActivity({ invoiceId: inv.id, promptTitle: answer.title, answer: answer.text, responsibleId: userId.value })
    try {
      await b24.call('crm.activity.configurable.add', { ...activity })
    } catch (e) {
      return { ...answer, notSaved: e instanceof Error ? e.message : String(e) }
    }
    return answer
  }

  return { invoice, existing, tasks, result, problems, conversion, vat, step, error, notice, writing, canWrite, totals, loadInvoice, reset, collect, write, consult }
}
