import { describe, expect, it } from 'vitest'
import { engineState, parseEngineList, registerParams, registerPlan, unregisterPlan, type SpyEngine } from '~/utils/spy'

const engine = (category: string, url = `https://app.example.com/api/engine/x.y/${category}`): SpyEngine =>
  ({ category, code: `sh_aiconnect_spy_${category}`, name: `TEST ${category}`, completionsUrl: url })

describe('parseEngineList (ai.engine.list shape, docs/RESEARCH.md)', () => {
  it('keeps well-formed records, drops junk', () => {
    const list = parseEngineList([
      { id: '2', app_code: 'x', code: 'sh_aiconnect_spy_text', category: 'text', completions_url: 'https://a/b' },
      { code: 1 },
      null
    ])
    expect(list.map(r => r.code)).toEqual(['sh_aiconnect_spy_text'])
    expect(parseEngineList({})).toEqual([])
  })
})

describe('registration plan', () => {
  const text = engine('text')
  const call = engine('call')

  it('register params follow the method docs', () => {
    expect(registerParams(text)).toEqual({
      name: 'TEST text',
      code: 'sh_aiconnect_spy_text',
      category: 'text',
      completions_url: text.completionsUrl,
      settings: { model_context_type: 'token', model_context_limit: 16000 }
    })
  })

  it('absent → register; ok → nothing; stale URL → unregister then register (re-register is refused)', () => {
    const registered = [
      { code: text.code, category: 'text', completions_url: text.completionsUrl },
      { code: call.code, category: 'call', completions_url: 'https://old.example.com/api/engine/x.y/call' }
    ]
    expect(engineState(text, registered)).toBe('ok')
    expect(engineState(call, registered)).toBe('stale')
    expect(engineState(engine('image'), registered)).toBe('absent')
    expect(registerPlan([text, call, engine('image')], registered).map(c => `${c.method}:${c.params.code}`)).toEqual([
      'ai.engine.unregister:sh_aiconnect_spy_call',
      'ai.engine.register:sh_aiconnect_spy_call',
      'ai.engine.register:sh_aiconnect_spy_image'
    ])
  })

  it('unregister only what is there', () => {
    const registered = [{ code: text.code, category: 'text', completions_url: 'https://old/x' }]
    expect(unregisterPlan([text, call], registered)).toEqual([{ method: 'ai.engine.unregister', params: { code: text.code } }])
  })
})
