import { describe, expect, it, vi } from 'vitest'
import { RATES_KEY, SETTINGS_KEY } from '#shared/domain/settings'
import { STORAGE_KEY } from '#shared/domain/storageBudget'
import type { RestCall } from '../../server/utils/b24Client'
import { saveRatesFor, saveSettingsFor, type WriteContext } from '../../server/utils/optionWrites'
import { readAllOptions, writeOptionWithinBudget } from '../../server/utils/options'

/** Портал с опциями приложения: `app.option.get` отдаёт их, `app.option.set` записывает. */
function portalOptions(initial: Record<string, unknown> = {}) {
  const options: Record<string, unknown> = { ...initial }
  const make = () => vi.fn<RestCall>(async (method, params) => {
    if (method === 'app.option.get') {
      const key = (params as { option?: string } | undefined)?.option
      return key === undefined ? { ...options } : options[key]
    }
    if (method === 'app.option.set') {
      Object.assign(options, (params as { options: Record<string, unknown> }).options)
      return true
    }
    throw new Error(`unexpected ${method}`)
  })
  return { options, make }
}

function ctx(p: ReturnType<typeof portalOptions>, over: Partial<WriteContext> = {}) {
  const frameCall = p.make()
  const installer = p.make()
  const installerCall = vi.fn(() => installer)
  return { c: { userId: 7, isAdmin: false, frameCall, installerCall, ...over } as WriteContext, frameCall, installer, installerCall }
}

const setCalls = (fn: ReturnType<typeof vi.fn>) => fn.mock.calls.filter(([method]) => method === 'app.option.set')

describe('saveSettingsFor', () => {
  it('не администратор — 403, в портал ничего не пишем', async () => {
    const p = portalOptions()
    const { c, frameCall } = ctx(p)
    expect((await saveSettingsFor(c, { settings: {} })).status).toBe(403)
    expect(frameCall).not.toHaveBeenCalled()
  })

  it('пустое тело — 400, а не сброс настроек к умолчаниям', async () => {
    const { c } = ctx(portalOptions(), { isAdmin: true })
    expect((await saveSettingsFor(c, null)).status).toBe(400)
    expect((await saveSettingsFor(c, { settings: 'x' })).status).toBe(400)
  })

  it('администратор — пишет его же токеном нормализованные настройки', async () => {
    const p = portalOptions()
    const { c, frameCall, installerCall } = ctx(p, { isAdmin: true })
    const res = await saveSettingsFor(c, { settings: { rounding: 30, currency: 'rub', junk: 'x' } })
    expect(res.status).toBe(200)
    expect(setCalls(frameCall)).toHaveLength(1)
    expect(installerCall).not.toHaveBeenCalled()
    const saved = JSON.parse(p.options[SETTINGS_KEY] as string)
    expect(saved).toMatchObject({ rounding: 30, currency: 'RUB' })
    expect(saved).not.toHaveProperty('junk')
  })

  it('не влезает в бюджет — 413 и без записи', async () => {
    const p = portalOptions({ [RATES_KEY]: 'x'.repeat(1500) })
    const { c, frameCall } = ctx(p, { isAdmin: true })
    const res = await saveSettingsFor(c, { settings: {} })
    expect(res.status).toBe(413)
    expect(res.body).toHaveProperty('usage')
    expect(setCalls(frameCall)).toHaveLength(0)
  })
})

describe('saveRatesFor', () => {
  const rates = [{ userId: 5, rate: 1500, from: '2026-01-01' }]

  it('редактор ставок (не администратор) пишет ТОКЕНОМ УСТАНОВЩИКА', async () => {
    const p = portalOptions({ [SETTINGS_KEY]: JSON.stringify({ rateEditors: [7] }) })
    const { c, frameCall, installer } = ctx(p)
    const res = await saveRatesFor(c, { rates })
    expect(res).toMatchObject({ status: 200, body: { ok: true, entries: 1 } })
    expect(setCalls(frameCall)).toHaveLength(0)
    expect(setCalls(installer)).toHaveLength(1)
    expect(p.options[RATES_KEY]).toBe('[[5,1500,"2026-01-01"]]')
  })

  it('администратор пишет своим токеном, установщик не нужен', async () => {
    const p = portalOptions()
    const { c, frameCall, installerCall } = ctx(p, { isAdmin: true })
    expect((await saveRatesFor(c, { rates })).status).toBe(200)
    expect(setCalls(frameCall)).toHaveLength(1)
    expect(installerCall).not.toHaveBeenCalled()
  })

  it('список редакторов — из портала: подделка в теле запроса не помогает', async () => {
    const p = portalOptions({ [SETTINGS_KEY]: JSON.stringify({ rateEditors: [99] }) })
    const { c, installerCall } = ctx(p)
    const res = await saveRatesFor(c, { rates, settings: { rateEditors: [7] }, rateEditors: [7] })
    expect(res.status).toBe(403)
    expect(installerCall).not.toHaveBeenCalled()
  })

  it('не массив объектов — 400; ошибки в строках — 422 со списком', async () => {
    const { c } = ctx(portalOptions(), { isAdmin: true })
    expect((await saveRatesFor(c, { rates: 'x' })).status).toBe(400)
    expect((await saveRatesFor(c, { rates: [null] })).status).toBe(400)
    expect((await saveRatesFor(c, {})).status).toBe(400)
    const res = await saveRatesFor(c, { rates: [{ userId: 5, rate: 0, from: '2026-01-01' }] })
    expect(res.status).toBe(422)
    expect(res.body.issues).toEqual([{ index: 0, message: expect.stringMatching(/больше 0/) }])
  })

  it('посторонние поля записей не попадают в хранилище', async () => {
    const p = portalOptions()
    const { c } = ctx(p, { isAdmin: true })
    await saveRatesFor(c, { rates: [{ ...rates[0], note: 'секрет', productId: 3 }] })
    expect(p.options[RATES_KEY]).toBe('[[5,1500,"2026-01-01"]]')
  })

  it('не влезает в бюджет — 413 и без записи', async () => {
    const p = portalOptions({ [SETTINGS_KEY]: 'x'.repeat(1400) })
    const { c, frameCall } = ctx(p, { isAdmin: true })
    const many = Array.from({ length: 10 }, (_, i) => ({ userId: i + 1, rate: 1000, from: '2026-01-01' }))
    expect((await saveRatesFor(c, { rates: many })).status).toBe(413)
    expect(setCalls(frameCall)).toHaveLength(0)
  })
})

describe('options: чтение и бюджет', () => {
  it('readAllOptions: не-строки сериализуются для подсчёта, не-объект — пусто', async () => {
    expect(await readAllOptions(async () => ({ a: 'x', b: 5, c: null }))).toEqual({ a: 'x', b: '5', c: '""' })
    expect(await readAllOptions(async () => [])).toEqual({})
    expect(await readAllOptions(async () => null)).toEqual({})
  })

  it('writeOptionWithinBudget считает ВСЕ ключи и учитывает замеренный предел', async () => {
    const write = vi.fn<RestCall>(async () => true)
    const big = 'x'.repeat(3000)
    // Без замера 3000 байт не влезают в 1400…
    expect((await writeOptionWithinBudget(async () => ({}), write, 'k', big)).ok).toBe(false)
    // …а с замеренным пределом 65 000 — влезают.
    const measured = { [STORAGE_KEY]: JSON.stringify({ limit: 65_000, at: '2026-09-24' }) }
    expect((await writeOptionWithinBudget(async () => measured, write, 'k', big)).ok).toBe(true)
    expect(write).toHaveBeenCalledTimes(1)
    expect(write).toHaveBeenCalledWith('app.option.set', { options: { k: big } })
  })
})
