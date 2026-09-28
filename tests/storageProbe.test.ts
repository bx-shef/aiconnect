import { describe, expect, it } from 'vitest'
import { runStorageProbe, type ProbeCall } from '~/utils/storageProbe'
import { phpSerializedLength, PROBE_KEY, STORAGE_KEY } from '#shared/domain/storageBudget'

/**
 * Имитация хранилища опций портала. Два способа отказа на пределе:
 * • strict — запись сверх предела отвергается ошибкой, данные целы;
 * • truncate — запись «проходит», но сериализация обрезана и не читается: пропадают ВСЕ опции
 *   (так ведёт себя PHP unserialize на обрезанной строке) — худший случай, ради него и копия.
 */
function fakePortal(limit: number, mode: 'strict' | 'truncate', initial: Record<string, string>) {
  let store: Record<string, string> | null = { ...initial }
  const call: ProbeCall = async (method, params) => {
    if (method === 'app.option.get') return store ?? {}
    if (method === 'app.option.set') {
      const next = { ...(store ?? {}), ...(params?.options as Record<string, string>) }
      if (phpSerializedLength(next) > limit) {
        if (mode === 'strict') throw new Error('INTERNAL_SERVER_ERROR: Internal server error')
        store = null
        return true
      }
      store = next
      return true
    }
    throw new Error(`unexpected ${method}`)
  }
  return { call, state: () => store }
}

const settings = { ift_settings_v1: '{"rounding":60,"currency":"RUB"}', ift_rates_v1: '[[7,100,"2026-01-01"]]' }

describe('замер предела app.option', () => {
  it('строгий портал: предел — последняя удачная ступень, настройки целы', async () => {
    const portal = fakePortal(65_535, 'strict', settings)
    const res = await runStorageProbe(portal.call, undefined, '2026-09-24')
    expect(res.hitLimit).toBe(true)
    expect(res.restored).toBe(false)
    expect(res.measured.limit).toBeLessThanOrEqual(65_535)
    expect(res.measured.limit).toBeGreaterThanOrEqual(65_000)
    expect(portal.state()).toMatchObject(settings)
    expect(JSON.parse(portal.state()![STORAGE_KEY]!)).toEqual({ limit: res.measured.limit, at: '2026-09-24' })
    expect(portal.state()![PROBE_KEY]).toBe('')
  })

  it('тихая порча на 2000: копия возвращается, предел — ниже порчи', async () => {
    const portal = fakePortal(2000, 'truncate', settings)
    const res = await runStorageProbe(portal.call)
    expect(res.hitLimit).toBe(true)
    expect(res.restored).toBe(true)
    expect(res.measured.limit).toBeLessThanOrEqual(2000)
    expect(portal.state()).toMatchObject(settings)
  })

  it('без предела в пределах замера — верхняя ступень, границы нет', async () => {
    const portal = fakePortal(Number.MAX_SAFE_INTEGER, 'strict', settings)
    const steps: number[] = []
    const res = await runStorageProbe(portal.call, s => steps.push(s.bytes))
    expect(res.hitLimit).toBe(false)
    expect(res.measured.limit).toBe(steps.at(-1))
    expect(res.measured.limit).toBeGreaterThan(260_000)
  })

  it('ступени меньше уже занятого места пропускаются', async () => {
    const big = { ...settings, ift_prompts: 'x'.repeat(5000) }
    const steps: number[] = []
    await runStorageProbe(fakePortal(Number.MAX_SAFE_INTEGER, 'strict', big).call, s => steps.push(s.bytes))
    expect(steps[0]).toBeGreaterThan(phpSerializedLength(big))
  })
})
