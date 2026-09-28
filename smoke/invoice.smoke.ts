// Сценарий счёта на живом портале: чтение теми же запросами, что страница, расчёт чистыми
// функциями приложения во всех сочетаниях настроек, запись «заменить»/«добавить», пакет с
// ошибкой посередине, дело консультации (только отказ вебхуку — создаёт его страница).
//
// Что ожидается независимо от кода — таблицами по засеву: какие задачи и записи попадут, дата и
// ставка каждой строки, наценка по первому совпадению, число строк, ошибки и предупреждения. Так
// ловится «проводка»: не та ставка, не тот тег, не та задача. Арифметика строки (округление
// секунд, цена, сумма) — та же формула-спецификация, что в коде: ошибку в самой формуле ловят
// юнит-тесты с мутациями (tests/time.test.ts, tests/markup.test.ts, tests/fill.test.ts), а не смок.

import { beforeAll, describe, expect, inject, it } from 'vitest'
import { AI_ICON, AI_LOGO, buildConsultActivity } from '#shared/domain/activity'
import { currencyConversion, parseCurrencies, type CurrencyConversion, type PortalCurrency } from '#shared/domain/currency'
import { buildRows, toProductRows, type FillMode, type TaskSource } from '#shared/domain/fill'
import { invoiceProblems, type InvoiceInfo } from '#shared/domain/invoice'
import { normalizeTag, type MarkupSettings } from '#shared/domain/markup'
import type { RateEntry } from '#shared/domain/rates'
import { defaultSettings, type AppSettings, type PriceMode } from '#shared/domain/settings'
import type { TaskInfo, TimeEntry } from '#shared/domain/tasks'
import type { RoundingDirection, RoundingStep } from '#shared/domain/time'
import { roundMoney } from '#shared/domain/money'
import { grossPrice, vatForInvoice, vatTotals, type CompanyVat } from '#shared/domain/vat'
import { addRowCall, replaceRowsCall } from '~/utils/invoiceRequests'
import { describeWrite } from '~/utils/writeOutcome'
import { connectPortal, type Portal } from './lib/portal'
import { fetchEntries, fetchTasks, readInvoice, readInvoiceRaw } from './lib/flow'

const env = inject('smokeEnv')
const fx = inject('fixture')

/** Ставки сотрудника вебхука: 100 до 01.09, 150 с 01.09 — запись задним числом попадает на 100. */
const ratesFor = (userId: number): RateEntry[] => [{ userId, rate: 100, from: '2026-01-01' }, { userId, rate: 150, from: '2026-09-01' }]

const MARKUPS: Record<'none' | 'tags', MarkupSettings> = {
  none: { defaultPercent: 0, tags: [] },
  // «дизайн» выше «Срочно»: у задачи дизайна оба тега — сработать должно первое правило.
  tags: { defaultPercent: 70, tags: [{ tag: 'дизайн', percent: 100 }, { tag: '#Срочно', percent: 50 }, { tag: 'ЧЧ1', percent: 20 }] }
}

/** Ожидаемая наценка задачи — таблицей, по тегам из засева (smoke/lib/seed.ts). */
type SeededTask = 'design' | 'plain' | 'tiny' | 'invoiceSi' | 'invoiceT1f'

function expectedMarkup(kind: keyof typeof MARKUPS, task: SeededTask): number {
  if (kind === 'none') return 0
  return { design: 100, plain: 70, tiny: 70, invoiceSi: 20, invoiceT1f: 70 }[task]
}

function expectedSeconds(seconds: number, step: RoundingStep, direction: RoundingDirection): number {
  if (step === 0) return seconds
  const s = step * 60
  return (direction === 'nearest' ? Math.round(seconds / s) : Math.ceil(seconds / s)) * s
}

const SOURCES = [
  { name: 'сделка → счёт в другой валюте', invoice: 'usd', source: 'deal' },
  { name: 'сделка → счёт в валюте ставок', invoice: 'base', source: 'deal' },
  { name: 'задачи счёта (SI_ и T1f_)', invoice: 'noDeal', source: 'invoice' }
] as const
const MODES: FillMode[] = ['task', 'time']
const ROUNDINGS: Array<[RoundingStep, RoundingDirection]> = [[0, 'up'], [30, 'up'], [60, 'nearest']]
const MARKUP_KINDS = ['none', 'tags'] as const
const PRICE_MODES: PriceMode[] = ['hour', 'sum']

const VARIANTS = SOURCES.flatMap(src => MODES.flatMap(mode => ROUNDINGS.flatMap(([step, direction]) => MARKUP_KINDS.flatMap(markup => PRICE_MODES.map(priceMode => ({
  label: `${src.name} · тип ${mode === 'task' ? 1 : 2} · округление ${step ? `${step} мин ${direction === 'up' ? 'вверх' : 'к ближайшему'}` : 'нет'} · наценка ${markup === 'tags' ? 'по тегам' : 'нет'} · в счёт ${priceMode === 'sum' ? 'сумма × 1' : 'цена часа × часы'}`,
  src, mode, step, direction, markup, priceMode
}))))))

/** НДС смока: 20% на «реквизиты» засева — счета usd, base и noDeal (smoke/lib/seed.ts). */
const VAT_RATE = 20

describe.skipIf(!env || !fx)('счёт из задач на живом портале', () => {
  let portal: Portal
  let currencies: PortalCurrency[]
  const invoices = new Map<string, InvoiceInfo>()
  const tasksBySource = new Map<TaskSource, TaskInfo[]>()
  const entries: TimeEntry[] = []
  const nameOf = new Map<number, SeededTask>()

  const vat = (): CompanyVat[] => [{ companyId: fx!.myCompanyId, title: 'IFT smoke', rate: VAT_RATE }]

  function settingsFor(v: typeof VARIANTS[number]): AppSettings {
    return { ...defaultSettings(), currency: fx!.baseCurrency, rounding: v.step, roundingDirection: v.direction, markup: MARKUPS[v.markup], measureCode: 796, priceMode: v.priceMode, vat: vat() }
  }

  /** Ставка НДС счёта — тем же путём, что страница (useInvoiceFill → vatForInvoice). */
  function vatRateOf(invoice: InvoiceInfo, settings: AppSettings): number | null {
    const choice = vatForInvoice(settings.vat, invoice.myCompanyId)
    if (!choice.ok) throw new Error(choice.problem)
    return choice.rate
  }

  /** Налоговые поля позиций и суммы счёта — то, чего нет в разборе приложения (он их не читает). */
  async function taxOf(invoiceId: number): Promise<{ rows: Array<Record<string, unknown>>, opportunity: number, taxValue: number }> {
    // Те же запросы и листание, что у страницы (readInvoiceRaw → invoiceRequests.ts).
    const { item, rows } = await readInvoiceRaw(portal, invoiceId)
    const o = (item as { item?: Record<string, unknown> })?.item ?? {}
    return { rows, opportunity: Number(o.opportunity), taxValue: Number(o.taxValue) }
  }

  beforeAll(async () => {
    portal = connectPortal(env!.hook)
    currencies = parseCurrencies(await portal.call('crm.currency.list', {}))
    for (const key of ['usd', 'base', 'noDeal'] as const) invoices.set(key, (await readInvoice(portal, fx!.invoices[key])).invoice)
    tasksBySource.set('deal', await fetchTasks(portal, 'deal', invoices.get('usd')!))
    tasksBySource.set('invoice', await fetchTasks(portal, 'invoice', invoices.get('noDeal')!))
    for (const t of [...tasksBySource.get('deal')!, ...tasksBySource.get('invoice')!]) entries.push(...(await fetchEntries(portal, t.id)).entries)
    for (const [name, id] of Object.entries(fx!.tasks)) if (name !== 'foreign' && name !== 'paging') nameOf.set(id, name as SeededTask)
  })

  it('задачи находятся по обоим источникам, чужая — нет; теги пришли из списка', () => {
    expect(tasksBySource.get('deal')!.map(t => t.id).sort()).toEqual([fx!.tasks.design, fx!.tasks.plain, fx!.tasks.tiny].sort())
    expect(tasksBySource.get('invoice')!.map(t => t.id).sort()).toEqual([fx!.tasks.invoiceSi, fx!.tasks.invoiceT1f].sort())
    // Регистр тега задаёт портал (тег — общая запись портала), поэтому сравнение — как в markup.ts.
    expect(tasksBySource.get('deal')!.find(t => t.id === fx!.tasks.design)?.tags.map(normalizeTag).sort()).toEqual(['дизайн', 'срочно'])
    expect(entries).toHaveLength(fx!.entries.length)
  })

  it.each(VARIANTS)('$label', (v) => {
    const invoice = invoices.get(v.src.invoice)!
    const settings = settingsFor(v)
    expect(invoiceProblems(invoice, settings, v.src.source)).toEqual([])
    const conv = currencyConversion(settings.currency, invoice.currencyId, currencies)
    if (!conv.ok) throw new Error(conv.problem)
    const conversion: CurrencyConversion | null = conv.conversion
    expect(conversion === null).toBe(invoice.currencyId === fx!.baseCurrency)
    const tasks = tasksBySource.get(v.src.source)!
    const built = buildRows({ mode: v.mode, tasks, entries, rates: ratesFor(fx!.userId), settings, conversion, vatRate: vatRateOf(invoice, settings) })
    const factor = conversion?.factor ?? 1

    // Каждая строка — по независимой формуле.
    for (const row of built.rows) {
      const task = nameOf.get(row.taskId)!
      const own = entries.filter(e => e.taskId === row.taskId && e.seconds > 0)
      const seconds = v.mode === 'task' ? own.reduce((s, e) => s + e.seconds, 0) : own.find(e => e.id === row.entryId)!.seconds
      const date = v.mode === 'task' ? own.map(e => e.date!).sort().at(-1)! : own.find(e => e.id === row.entryId)!.date!
      const base = date < '2026-09-01' ? 100 : 150
      const percent = expectedMarkup(v.markup, task)
      expect(row).toMatchObject({ seconds, rateDate: date, baseRate: base, markupPercent: percent })
      expect(row.roundedSeconds).toBe(expectedSeconds(seconds, v.step, v.direction))
      expect(row.hours).toBe(Math.round(row.roundedSeconds / 3600 * 10_000) / 10_000)
      expect(row.hourPrice).toBe(roundMoney(base * factor * (100 + percent) / 100))
      expect(row.sum).toBe(roundMoney(row.hourPrice * row.hours))
      expect([row.price, row.quantity]).toEqual(v.priceMode === 'sum' ? [row.sum, 1] : [row.hourPrice, row.hours])
      expect(row.taxRate).toBe(VAT_RATE)
    }

    // Строки, ошибки и предупреждения — по таблице засева. К ближайшему часу обнуляются: в типе 1 —
    // «звонок» (15 мин), в типе 2 — он же и «короткая правка» (10 мин).
    const nearestHour = v.src.source === 'deal' && v.step === 60 && v.direction === 'nearest'
    const zeroed = nearestHour ? (v.mode === 'task' ? 1 : 2) : 0
    const expectedRows = (v.src.source === 'deal' ? (v.mode === 'task' ? 3 : 5) : (v.mode === 'task' ? 2 : 1)) - zeroed
    expect(built.rows).toHaveLength(expectedRows)
    const emptyComment = v.mode === 'time' && v.src.source === 'invoice'
    expect(built.errors.map(e => e.taskId)).toEqual(emptyComment ? [fx!.tasks.invoiceT1f] : [])
    const warnings = built.warnings.map(w => w.message)
    expect(warnings.some(w => w.startsWith('Цены пересчитаны'))).toBe(conversion !== null)
    if (conversion) expect(warnings[0]).toContain('проверьте курс')
    expect(warnings.some(w => w.includes('менялась за время задачи'))).toBe(v.mode === 'task' && v.src.source === 'deal')
    expect(warnings.filter(w => w.includes('после округления стало нулём'))).toHaveLength(zeroed)
  })

  it('источник «сделка» у счёта без сделки — остановка до чтения задач', () => {
    expect(invoiceProblems(invoices.get('noDeal')!, { ...defaultSettings(), currency: fx!.baseCurrency, vat: vat() }, 'deal'))
      .toEqual(['Счёт не связан со сделкой — выберите задачи, привязанные к самому счёту'])
  })

  it('НДС: реквизиты счёта читаются из crm.item.get; счёт без реквизитов — остановка', async () => {
    expect(invoices.get('usd')!.myCompanyId).toBe(fx!.myCompanyId)
    // У счёта листания реквизитов нет — портал отдаёт mycompanyId = 0.
    const bare = (await readInvoice(portal, fx!.invoices.paging)).invoice
    expect(bare.myCompanyId).toBeNull()
    expect(invoiceProblems(bare, { ...defaultSettings(), currency: fx!.baseCurrency, vat: vat() }, 'invoice'))
      .toEqual(['В счёте не выбраны «Реквизиты вашей компании» — выберите их в карточке счёта: по ним берётся ставка НДС'])
  })

  it('валюта без курса в портале — остановка с понятной причиной', () => {
    const missing = ['JPY', 'CNY', 'CHF', 'GBP'].find(code => !currencies.some(c => c.code === code))!
    const res = currencyConversion(fx!.baseCurrency, missing, currencies)
    expect(res).toMatchObject({ ok: false, problem: expect.stringContaining(`нет курса ${missing}`) })
  })

  it('нет ставки на дату — ошибка по каждой задаче, строк нет', () => {
    const built = buildRows({ mode: 'task', tasks: tasksBySource.get('deal')!, entries, rates: [], settings: { ...defaultSettings(), currency: fx!.baseCurrency }, vatRate: null })
    expect(built.rows).toEqual([])
    expect(built.errors).toHaveLength(3)
    for (const e of built.errors) expect(e.message).toContain('нет ставки')
  })

  describe('запись в счёт (последовательно)', () => {
    const variant = VARIANTS.find(v => v.src.invoice === 'usd' && v.mode === 'task' && v.step === 30 && v.markup === 'tags' && v.priceMode === 'hour')!
    /** Строки «Заменить» — чтобы после «Добавить» сверить итог всего счёта. */
    let replaced: ReturnType<typeof buildRows>['rows'] = []

    it('«Заменить»: позиции = строки предпросмотра с НДС сверху, сумму и налог портал считает так же', async () => {
      const settings = settingsFor(variant)
      const conv = currencyConversion(settings.currency, invoices.get('usd')!.currencyId, currencies)
      const built = buildRows({ mode: 'task', tasks: tasksBySource.get('deal')!, entries, rates: ratesFor(fx!.userId), settings, conversion: conv.ok ? conv.conversion : null, vatRate: VAT_RATE })
      const { method, params } = replaceRowsCall(fx!.invoices.usd, toProductRows(built.rows, settings))
      await portal.call(method, params)
      const after = await readInvoice(portal, fx!.invoices.usd)
      // В поле price портал хранит цену С налогом — ровно ту, что ушла.
      expect(after.rows.map(r => [r.productName, r.price, r.quantity])).toEqual(built.rows.map(r => [r.name, grossPrice(r.price, VAT_RATE), r.quantity]))
      const tax = await taxOf(fx!.invoices.usd)
      // Цену без НДС портал выделил сам — это цена строки предпросмотра.
      expect(tax.rows.map(r => [Number(r.priceExclusive), Number(r.taxRate), r.taxIncluded])).toEqual(built.rows.map(r => [r.price, VAT_RATE, 'N']))
      const totals = vatTotals(built.rows)
      expect([tax.opportunity, tax.taxValue]).toEqual([totals.total, totals.vat])
      expect(describeWrite({ mode: 'replace', planned: built.rows.length, before: 0, after: after.rows.length, error: null }).kind).toBe('done')
      replaced = built.rows
    })

    it('«Добавить» в режиме «сумма × 1»: строки после существующих, количество 1, итог счёта сходится', async () => {
      const settings = { ...settingsFor(variant), rounding: 0 as const, priceMode: 'sum' as const }
      const before = await readInvoice(portal, fx!.invoices.usd)
      const conv = currencyConversion(settings.currency, before.invoice.currencyId, currencies)
      const built = buildRows({ mode: 'time', tasks: tasksBySource.get('deal')!, entries, rates: ratesFor(fx!.userId), settings, conversion: conv.ok ? conv.conversion : null, vatRate: VAT_RATE })
      const sortStart = before.rows.reduce((m, r) => Math.max(m, r.sort), 0)
      const calls = toProductRows(built.rows, settings, sortStart).map((f): [string, Record<string, unknown>] => {
        const { method, params } = addRowCall(fx!.invoices.usd, f)
        return [method, params]
      })
      const res = await portal.batch(calls, true)
      expect(res.ok).toBe(true)
      const after = await readInvoice(portal, fx!.invoices.usd)
      expect(after.rows).toHaveLength(before.rows.length + built.rows.length)
      expect(Math.min(...after.rows.slice(before.rows.length).map(r => r.sort))).toBeGreaterThan(sortStart)
      expect(after.rows.slice(before.rows.length).map(r => [r.price, r.quantity])).toEqual(built.rows.map(r => [grossPrice(r.sum, VAT_RATE), 1]))
      const tax = await taxOf(fx!.invoices.usd)
      const totals = vatTotals([...replaced, ...built.rows])
      expect([tax.opportunity, tax.taxValue]).toEqual([totals.total, totals.vat])
      expect(describeWrite({ mode: 'append', planned: built.rows.length, before: before.rows.length, after: after.rows.length, error: null }).kind).toBe('done')
    })

    it('«Добавить» с ошибкой посередине: портал останавливается, итог — «добавлено 1 из 3»', async () => {
      const before = await readInvoice(portal, fx!.invoices.base)
      const row = { productName: `${fx!.runTag}: строка пакета`, price: 1, quantity: 1, sort: 10 }
      const res = await portal.batch([
        ['crm.item.productrow.add', addRowCall(fx!.invoices.base, row).params],
        ['crm.item.productrow.add', addRowCall(999_999_999, row).params],
        ['crm.item.productrow.add', addRowCall(fx!.invoices.base, { ...row, sort: 20 }).params]
      ], true)
      expect(res.ok).toBe(false)
      expect(res.answers.map(a => a.ok)).toEqual([true, false])
      const after = await readInvoice(portal, fx!.invoices.base)
      expect(after.rows).toHaveLength(before.rows.length + 1)
      const verdict = describeWrite({ mode: 'append', planned: 3, before: before.rows.length, after: after.rows.length, error: res.errors.join('; ') })
      expect(verdict).toMatchObject({ kind: 'error', resetPreview: true })
      expect(verdict.message).toContain('добавлено 1 из 3')
    })

    it('дело консультации: вебхук его не создаёт (ERROR_WRONG_CONTEXT) — только страница во фрейме', async () => {
      // crm.activity.configurable.add работает лишь в контексте приложения (документация) — смок
      // на вебхуке может только подтвердить отказ. Вид записи закрепляют юнит-тесты layout
      // (tests/activity.test.ts), живую запись — владелец из приложения.
      const activity = buildConsultActivity({ invoiceId: fx!.invoices.usd, promptTitle: `Смок ${fx!.runTag}`, answer: '**Итог**\n- пункт', responsibleId: fx!.userId })
      // SDK отдаёт текст ошибки без кода: «Вызов метода возможен только в контексте rest приложения» (замер).
      await expect(portal.call('crm.activity.configurable.add', { ...activity })).rejects.toThrow(/ERROR_WRONG_CONTEXT|только в контексте rest приложения/)
    })

    it('иконка и логотип записи консультации есть в портале (коды записей ИИ ядра)', async () => {
      const icons = JSON.stringify(await portal.call('crm.timeline.icon.list', {}))
      const logos = JSON.stringify(await portal.call('crm.timeline.logo.list', {}))
      expect(icons).toContain(`"${AI_ICON}"`)
      expect(logos).toContain(`"${AI_LOGO}"`)
    })
  })
})
