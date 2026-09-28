import { describe, expect, it } from 'vitest'
import { describeWrite } from '~/utils/writeOutcome'

describe('describeWrite — «Добавить»', () => {
  const base = { mode: 'append' as const, planned: 10, before: 3 }

  it('всё добавилось — готово, предпросмотр не сбрасываем', () => {
    expect(describeWrite({ ...base, after: 13, error: null })).toEqual({ kind: 'done', message: 'Добавлено строк: 10.', resetPreview: false })
  })

  it('ошибка посередине — «добавлено N из M» и сброс, чтобы повтор не задвоил', () => {
    const v = describeWrite({ ...base, after: 7, error: 'ACCESS_DENIED' })
    expect(v).toMatchObject({ kind: 'error', resetPreview: true })
    expect(v.message).toContain('добавлено 4 из 10 строк')
    expect(v.message).toContain('ACCESS_DENIED')
  })

  it('ошибка и счёт не перечитался — не «добавлено 0», а честное «не удалось проверить»', () => {
    const v = describeWrite({ ...base, after: null, error: 'timeout' })
    expect(v).toMatchObject({ kind: 'error', resetPreview: true })
    expect(v.message).toContain('проверить не удалось')
    expect(v.message).not.toContain('Добавлено 0')
  })

  it('успех, но строк больше ожидаемого (повтор запроса, чужие правки) — предупреждение и сброс', () => {
    const v = describeWrite({ ...base, after: 23, error: null })
    expect(v).toMatchObject({ kind: 'warn', resetPreview: true })
    expect(v.message).toContain('23 вместо 13')
  })

  it('успех, счёт не перечитался — предупреждение', () => {
    expect(describeWrite({ ...base, after: null, error: null })).toMatchObject({ kind: 'warn', resetPreview: false })
  })

  it('перечитанных позиций меньше, чем было, — не отрицательное число', () => {
    expect(describeWrite({ ...base, after: 1, error: 'x' }).message).toContain('добавлено 0 из 10')
  })

  it('ответ — ошибка, но все строки уже в счёте: предупреждение «повторять не нужно», а не «соберите заново»', () => {
    const v = describeWrite({ ...base, after: 13, error: 'Request timeout exceeded' })
    expect(v).toMatchObject({ kind: 'warn', resetPreview: true })
    expect(v.message).toContain('повторять не нужно')
    expect(v.message).not.toContain('соберите')
  })

  it('успех, но строк МЕНЬШЕ ожидаемого — тоже предупреждение, а не «готово»', () => {
    expect(describeWrite({ ...base, after: 12, error: null })).toMatchObject({ kind: 'warn', resetPreview: true })
  })
})

describe('describeWrite — «Заменить»', () => {
  const base = { mode: 'replace' as const, planned: 5, before: 9 }

  it('позиций столько, сколько записывали, — готово', () => {
    expect(describeWrite({ ...base, after: 5, error: null })).toMatchObject({ kind: 'done', resetPreview: false })
  })

  it('ошибка ответа — повторить безопасно, предпросмотр оставляем; состояние счёта — фактом', () => {
    const v = describeWrite({ ...base, after: 5, error: 'timeout' })
    expect(v).toMatchObject({ kind: 'error', resetPreview: false })
    expect(v.message).toContain('Сейчас в счёте позиций: 5')
    expect(v.message).toContain('безопасно')
  })

  it('успех, но позиций другое число — предупреждение', () => {
    expect(describeWrite({ ...base, after: 6, error: null })).toMatchObject({ kind: 'warn' })
  })
})
