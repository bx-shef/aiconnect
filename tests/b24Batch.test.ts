import { describe, expect, it } from 'vitest'
import { B24CallError, unwrapBatchPart, type BatchCall, type BatchItem } from '~/utils/b24Batch'

const ok = <T>(result: T): BatchItem<T> => ({ isSuccess: true, getData: () => ({ result }), getErrorMessages: () => [] })
const fail = (msg: string): BatchItem<never> => ({ isSuccess: false, getData: () => undefined, getErrorMessages: () => [msg] })
const part: BatchCall[] = [['crm.item.productrow.add', {}], ['crm.item.productrow.add', {}], ['user.get', {}]]

describe('unwrapBatchPart', () => {
  it('все ответы — результаты по порядку команд', () => {
    expect(unwrapBatchPart([ok(1), ok(2), ok(3)], part)).toEqual([1, 2, 3])
  })

  it('ошибка команды — исключение с методом этой команды', () => {
    expect(() => unwrapBatchPart([ok(1), fail('ACCESS_DENIED'), ok(3)], part)).toThrow('crm.item.productrow.add: ACCESS_DENIED')
  })

  it('ответов меньше, чем команд (портал остановил пакет) — исключение с первой невыполненной', () => {
    try {
      unwrapBatchPart([ok(1)], part)
      expect.unreachable()
    } catch (e) {
      expect(e).toBeInstanceOf(B24CallError)
      expect((e as B24CallError).method).toBe('crm.item.productrow.add')
      expect((e as Error).message).toContain('пакет остановлен порталом')
    }
    expect(() => unwrapBatchPart([ok(1), ok(2)], part)).toThrow('user.get')
    expect(() => unwrapBatchPart([], part)).toThrow('crm.item.productrow.add')
  })

  it('B24CallError без текста — «неизвестная ошибка»', () => {
    expect(new B24CallError('x', []).message).toBe('x: неизвестная ошибка')
  })
})
