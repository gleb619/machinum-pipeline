import { createExchange, getVariable, setVariable } from '@mt/core'
import type { Exchange, ToolContext } from '@mt/core'
import { describe, expect, it } from 'vitest'
import { MAX_UNTRANSLATED_SHARE, MIN_CYRILLIC_RATIO } from './constants.js'
import { VAR_CONSTANTS, resolveTunedNum, resolveTunedStr } from './resolve-constants.js'
import { createStatProofread } from './verification/stat-proofread.js'
import type { ProofreadReport } from './verification/stat-proofread.js'

function ctxStub(settings: Record<string, unknown> = {}, env: Record<string, string> = {}) {
  return { run: { global: { settings, env } } } as unknown as ToolContext
}

function exWithConstants(map: Record<string, unknown>): Exchange<string> {
  return setVariable(createExchange('text'), VAR_CONSTANTS, map)
}

describe('resolveTunedNum', () => {
  it('falls back to the constant when no layer defines the name', () => {
    expect(resolveTunedNum('DEFAULT_CHUNK_TARGET', 6000)).toBe(6000)
    expect(resolveTunedNum('DEFAULT_CHUNK_TARGET', 6000, createExchange('text'), ctxStub())).toBe(
      6000,
    )
  })

  it('variable constants layer wins over settings and env', () => {
    process.env.MT_CONST_DEFAULT_CHUNK_TARGET = '111'
    try {
      const ex = exWithConstants({ DEFAULT_CHUNK_TARGET: 333 })
      const ctx = ctxStub({ 'constants.DEFAULT_CHUNK_TARGET': 222 })
      expect(resolveTunedNum('DEFAULT_CHUNK_TARGET', 6000, ex, ctx)).toBe(333)
    } finally {
      Reflect.deleteProperty(process.env, 'MT_CONST_DEFAULT_CHUNK_TARGET')
    }
  })

  it('settings.constants layer wins over env', () => {
    process.env.MT_CONST_DEFAULT_CHUNK_TARGET = '111'
    try {
      const ctx = ctxStub({ 'constants.DEFAULT_CHUNK_TARGET': 222 })
      expect(resolveTunedNum('DEFAULT_CHUNK_TARGET', 6000, createExchange('text'), ctx)).toBe(222)
    } finally {
      Reflect.deleteProperty(process.env, 'MT_CONST_DEFAULT_CHUNK_TARGET')
    }
  })

  it('env layer (process.env) beats the fallback', () => {
    process.env.MT_CONST_DEFAULT_CHUNK_TARGET = '111'
    try {
      expect(resolveTunedNum('DEFAULT_CHUNK_TARGET', 6000, createExchange('text'))).toBe(111)
    } finally {
      Reflect.deleteProperty(process.env, 'MT_CONST_DEFAULT_CHUNK_TARGET')
    }
  })

  it('ctx.run.global.env overlays process.env', () => {
    process.env.MT_CONST_DEFAULT_CHUNK_TARGET = '111'
    try {
      const ctx = ctxStub({}, { MT_CONST_DEFAULT_CHUNK_TARGET: '222' })
      expect(resolveTunedNum('DEFAULT_CHUNK_TARGET', 6000, createExchange('text'), ctx)).toBe(222)
    } finally {
      Reflect.deleteProperty(process.env, 'MT_CONST_DEFAULT_CHUNK_TARGET')
    }
  })

  it('accepts numeric strings on every layer', () => {
    const ex = exWithConstants({ DEFAULT_CHUNK_TARGET: '333' })
    expect(resolveTunedNum('DEFAULT_CHUNK_TARGET', 6000, ex)).toBe(333)
    const ctx = ctxStub({ 'constants.DEFAULT_CHUNK_TARGET': '222' })
    expect(resolveTunedNum('DEFAULT_CHUNK_TARGET', 6000, createExchange('text'), ctx)).toBe(222)
  })

  it('absent values fall through to the next layer', () => {
    const ctx = ctxStub({ 'constants.DEFAULT_CHUNK_TARGET': 222 })
    // variables map without the name; settings layer supplies the value
    expect(resolveTunedNum('DEFAULT_CHUNK_TARGET', 6000, exWithConstants({}), ctx)).toBe(222)
    // empty-string env value is absent
    process.env.MT_CONST_DEFAULT_CHUNK_TARGET = ''
    try {
      expect(resolveTunedNum('DEFAULT_CHUNK_TARGET', 6000, createExchange('text'))).toBe(6000)
    } finally {
      Reflect.deleteProperty(process.env, 'MT_CONST_DEFAULT_CHUNK_TARGET')
    }
    // null / undefined entries in the variables map are absent
    expect(resolveTunedNum('DEFAULT_CHUNK_TARGET', 6000, exWithConstants({ A: null }))).toBe(6000)
  })

  it('throws citing the source for invalid values on each layer', () => {
    expect(() =>
      resolveTunedNum(
        'DEFAULT_CHUNK_TARGET',
        6000,
        exWithConstants({ DEFAULT_CHUNK_TARGET: 'abc' }),
      ),
    ).toThrow('variable constants.DEFAULT_CHUNK_TARGET')
    expect(() =>
      resolveTunedNum(
        'DEFAULT_CHUNK_TARGET',
        6000,
        createExchange('text'),
        ctxStub({ 'constants.DEFAULT_CHUNK_TARGET': true }),
      ),
    ).toThrow('settings.constants.DEFAULT_CHUNK_TARGET')
    process.env.MT_CONST_DEFAULT_CHUNK_TARGET = 'nope'
    try {
      expect(() => resolveTunedNum('DEFAULT_CHUNK_TARGET', 6000, createExchange('text'))).toThrow(
        'env MT_CONST_DEFAULT_CHUNK_TARGET',
      )
    } finally {
      Reflect.deleteProperty(process.env, 'MT_CONST_DEFAULT_CHUNK_TARGET')
    }
  })

  it('a valid higher layer shields an invalid lower layer', () => {
    process.env.MT_CONST_DEFAULT_CHUNK_TARGET = 'nope'
    try {
      const ctx = ctxStub({ 'constants.DEFAULT_CHUNK_TARGET': 222 })
      expect(resolveTunedNum('DEFAULT_CHUNK_TARGET', 6000, createExchange('text'), ctx)).toBe(222)
    } finally {
      Reflect.deleteProperty(process.env, 'MT_CONST_DEFAULT_CHUNK_TARGET')
    }
  })
})

describe('resolveTunedStr', () => {
  it('falls back to the constant when no layer defines the name', () => {
    expect(resolveTunedStr('DEFAULT_CHUNK_SEPARATOR', '---')).toBe('---')
  })

  it('resolves the variable layer over settings over env', () => {
    process.env.MT_CONST_DEFAULT_CHUNK_SEPARATOR = 'from-env'
    try {
      const ex = exWithConstants({ DEFAULT_CHUNK_SEPARATOR: 'from-var' })
      const ctx = ctxStub({ 'constants.DEFAULT_CHUNK_SEPARATOR': 'from-settings' })
      expect(resolveTunedStr('DEFAULT_CHUNK_SEPARATOR', '---', ex, ctx)).toBe('from-var')
      expect(resolveTunedStr('DEFAULT_CHUNK_SEPARATOR', '---', createExchange('text'), ctx)).toBe(
        'from-settings',
      )
      expect(resolveTunedStr('DEFAULT_CHUNK_SEPARATOR', '---', createExchange('text'))).toBe(
        'from-env',
      )
    } finally {
      Reflect.deleteProperty(process.env, 'MT_CONST_DEFAULT_CHUNK_SEPARATOR')
    }
  })

  it('empty string is absent and falls through', () => {
    const ex = exWithConstants({ DEFAULT_CHUNK_SEPARATOR: '' })
    const ctx = ctxStub({ 'constants.DEFAULT_CHUNK_SEPARATOR': 'from-settings' })
    expect(resolveTunedStr('DEFAULT_CHUNK_SEPARATOR', '---', ex, ctx)).toBe('from-settings')
  })

  it('throws citing the source for non-string values', () => {
    expect(() =>
      resolveTunedStr(
        'DEFAULT_CHUNK_SEPARATOR',
        '---',
        exWithConstants({ DEFAULT_CHUNK_SEPARATOR: 5 }),
      ),
    ).toThrow('variable constants.DEFAULT_CHUNK_SEPARATOR')
    const ctx = ctxStub({}, { MT_CONST_DEFAULT_CHUNK_SEPARATOR: 'from-global-env' })
    expect(resolveTunedStr('DEFAULT_CHUNK_SEPARATOR', '---', createExchange('text'), ctx)).toBe(
      'from-global-env',
    )
  })
})

describe('stat-proofread end-to-end overrides', () => {
  const latin = 'hello world this is untranslated latin text with plenty of letters'

  async function invoke(
    ex: Exchange<string>,
    ctx: ToolContext,
    options: Parameters<typeof createStatProofread>[0] = {},
  ): Promise<ProofreadReport> {
    const out = await createStatProofread(options).invoke(ex, ctx)
    const report = getVariable<ProofreadReport>(out, 'proofread')
    if (!report) throw new Error('proofread variable missing')
    return report
  }

  it('flags low-cyrillic by default; the variables layer relaxes the threshold', async () => {
    const defaulted = await invoke(createExchange(latin), ctxStub())
    expect(defaulted.ok).toBe(false)
    expect(defaulted.issues.map((i) => i.kind)).toContain('low-cyrillic')
    expect(MIN_CYRILLIC_RATIO).toBeGreaterThan(0)

    const viaVariable = await invoke(exWithConstants({ MIN_CYRILLIC_RATIO: 0 }), ctxStub())
    expect(viaVariable.ok).toBe(false) // untranslated-segment still fires
    expect(viaVariable.issues.map((i) => i.kind)).not.toContain('low-cyrillic')
  })

  it('the settings.constants layer reaches the tool', async () => {
    const viaSettings = await invoke(
      createExchange(latin),
      ctxStub({ 'constants.MAX_UNTRANSLATED_SHARE': 1 }),
    )
    expect(viaSettings.issues.map((i) => i.kind)).not.toContain('untranslated-segment')
    expect(viaSettings.untranslatedShare).toBeGreaterThan(MAX_UNTRANSLATED_SHARE)
  })

  it('explicit tool option still wins over the constants variable', async () => {
    const report = await invoke(exWithConstants({ MIN_CYRILLIC_RATIO: 0 }), ctxStub(), {
      minCyrillicShare: 0.9,
    })
    expect(report.ok).toBe(false)
  })
})
