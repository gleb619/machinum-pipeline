import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { assertRealBackend, modelEnvVar, pickFor } from '../lib/llm.js'

/**
 * Isolate the settings layer: `lib/llm.ts` reads `mt.local.json` through
 * `readMtConfigSync`, so mocking that one export keeps this file from rewriting or deleting the
 * real `samples/sample2-practical/mt.local.json` while other Vitest workers read the sample
 * config. Every other `@mt/core` export is the real one.
 */
const { readMtConfigSyncMock } = vi.hoisted(() => ({ readMtConfigSyncMock: vi.fn() }))

vi.mock('@mt/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@mt/core')>()
  return { ...actual, readMtConfigSync: readMtConfigSyncMock }
})

const PAID = 'openai/gpt-4o-mini'
const FREE = 'nvidia/nemotron-3-ultra-550b-a55b:free'

beforeEach(() => {
  readMtConfigSyncMock.mockReset()
  readMtConfigSyncMock.mockReturnValue({ settings: {} })
  vi.stubEnv('MT_LLM_TOOL', 'router')
  vi.stubEnv('MT_LLM_USE', '')
  vi.stubEnv('MT_LLM_MODEL', '')
  vi.stubEnv('MT_LLM_MODEL_SUMMARY', '')
  vi.stubEnv('MT_ALLOW_PAID', '')
})

afterEach(() => {
  vi.unstubAllEnvs()
  readMtConfigSyncMock.mockReset()
})

describe('free-model guard', () => {
  it('rejects a paid id and names the env var to fix', () => {
    vi.stubEnv('MT_LLM_MODEL_SUMMARY', PAID)
    expect(() => pickFor('summary')).toThrow(/MT_LLM_MODEL_SUMMARY/)
    expect(() => pickFor('summary')).toThrow(/free models only/)
  })

  it('accepts a :free id', () => {
    vi.stubEnv('MT_LLM_MODEL_SUMMARY', FREE)
    const llm = pickFor('summary')
    expect(llm.tool).toBe('router')
    expect(llm.model).toBe(FREE)
  })

  it('accepts the offline mock backend', () => {
    vi.stubEnv('MT_LLM_TOOL', 'mock')
    expect(pickFor('summary').tool).toBe('mock')
  })

  it('honours MT_ALLOW_PAID=1', () => {
    vi.stubEnv('MT_LLM_MODEL_SUMMARY', PAID)
    vi.stubEnv('MT_ALLOW_PAID', '1')
    expect(pickFor('summary').model).toBe(PAID)
  })

  it('rejects a paid model from the settings layer (mt.local.json)', () => {
    readMtConfigSyncMock.mockReturnValue({ settings: { 'llm.model.summary': PAID } })
    expect(() => pickFor('summary')).toThrow(/MT_LLM_MODEL_SUMMARY/)
  })

  it('sanitizes the per-stage env var name', () => {
    expect(modelEnvVar('translate')).toBe('MT_LLM_MODEL_TRANSLATE')
    expect(modelEnvVar('post-process')).toBe('MT_LLM_MODEL_POST_PROCESS')
  })
})

describe('no-mock guard', () => {
  beforeEach(() => {
    // Stub the Vitest marker so the guard behaves as it does for a real `mt run`.
    vi.stubEnv('VITEST', '')
    vi.stubEnv('MT_ALLOW_MOCK', '')
    vi.stubEnv('MT_LLM_TOOL', 'mock')
  })

  it('throws for mock without MT_ALLOW_MOCK and names the stage', () => {
    expect(() => pickFor('summary')).toThrow(/\[summary\]/)
    expect(() => pickFor('summary')).toThrow(/mock/)
    expect(() => pickFor('summary')).toThrow(/mt\.local\.json/)
    expect(() => pickFor('summary')).toThrow(/MT_ALLOW_MOCK=1/)
  })

  it('passes for mock with MT_ALLOW_MOCK=1', () => {
    vi.stubEnv('MT_ALLOW_MOCK', '1')
    expect(pickFor('summary').tool).toBe('mock')
  })

  it('passes for a free real backend', () => {
    vi.stubEnv('MT_LLM_TOOL', 'router')
    vi.stubEnv('MT_LLM_MODEL_SUMMARY', FREE)
    expect(pickFor('summary').tool).toBe('router')
  })

  it('does not refuse a non-mock backend directly', () => {
    expect(() => assertRealBackend('summary', 'router')).not.toThrow()
  })
})
