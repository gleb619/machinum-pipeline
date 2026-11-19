import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Logger } from '@mt/core'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { assertFreeModel, assertRealBackend, createBookLlmPicker, modelEnvVar } from './llm.js'

let root: string

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'mt-bookkit-llm-'))
  writeFileSync(
    join(root, 'mt.json'),
    JSON.stringify({
      settings: {
        'llm.tool': 'mock',
        'llm.model': 'mock',
        'llm.model.summary': 'free/model:free',
      },
    }),
  )
})

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

function captureLogger(): { logger: Logger; lines: string[] } {
  const lines: string[] = []
  return {
    lines,
    logger: {
      info: (message) => lines.push(message),
      warn: () => {},
      error: () => {},
      debug: () => {},
    },
  }
}

describe('modelEnvVar', () => {
  it('sanitizes the per-stage env var name', () => {
    expect(modelEnvVar('translate')).toBe('MT_LLM_MODEL_TRANSLATE')
    expect(modelEnvVar('post-process')).toBe('MT_LLM_MODEL_POST_PROCESS')
    expect(modelEnvVar('a b/c')).toBe('MT_LLM_MODEL_A_B_C')
  })
})

describe('assertFreeModel', () => {
  it('is permissive by default', () => {
    expect(() => assertFreeModel('router', 'openai/gpt-4o-mini')).not.toThrow()
  })

  it('accepts free ids and the offline mock backend', () => {
    expect(() =>
      assertFreeModel('router', 'vendor/model:free', 'MT_LLM_MODEL_X', { freeOnly: true }),
    ).not.toThrow()
    expect(() =>
      assertFreeModel('mock', 'openai/gpt-4o-mini', 'MT_LLM_MODEL_X', { freeOnly: true }),
    ).not.toThrow()
  })

  it('rejects a paid id and names the env var to fix', () => {
    expect(() =>
      assertFreeModel('router', 'openai/gpt-4o-mini', 'MT_LLM_MODEL_SUMMARY', {
        freeOnly: true,
      }),
    ).toThrow(/MT_LLM_MODEL_SUMMARY/)
    expect(() =>
      assertFreeModel('router', 'openai/gpt-4o-mini', 'MT_LLM_MODEL_SUMMARY', {
        freeOnly: true,
      }),
    ).toThrow(/free models only/)
  })

  it('honours the paid-run escape hatch without mutating process.env', () => {
    expect(() =>
      assertFreeModel('router', 'openai/gpt-4o-mini', 'MT_LLM_MODEL_SUMMARY', {
        freeOnly: true,
        allowPaidEnv: 'MT_BOOKKIT_ALLOW_PAID',
        env: { MT_BOOKKIT_ALLOW_PAID: '1' },
      }),
    ).not.toThrow()
  })
})

describe('assertRealBackend', () => {
  it('is permissive by default and allows real backends', () => {
    expect(() => assertRealBackend('summary', 'mock')).not.toThrow()
    expect(() => assertRealBackend('summary', 'router', { requireRealBackend: true })).not.toThrow()
  })

  it('rejects mock when the real-backend guard is on', () => {
    expect(() =>
      assertRealBackend('summary', 'mock', {
        requireRealBackend: true,
        allowMockEnv: 'MT_BOOKKIT_ALLOW_MOCK',
        env: {},
      }),
    ).toThrow(/\[summary\].*mock/)
  })

  it('honours the mock escape hatch without mutating process.env', () => {
    expect(() =>
      assertRealBackend('summary', 'mock', {
        requireRealBackend: true,
        allowMockEnv: 'MT_BOOKKIT_ALLOW_MOCK',
        env: { MT_BOOKKIT_ALLOW_MOCK: '1' },
      }),
    ).not.toThrow()
  })
})

describe('createBookLlmPicker', () => {
  it('returns the offline mock choice and applies a free per-tool model override', () => {
    const { logger, lines } = captureLogger()
    const picker = createBookLlmPicker({
      root,
      env: {},
      logger,
      guard: { freeOnly: true },
    })
    const llm = picker.pickFor('summary')
    expect(llm.tool).toBe('mock')
    expect(llm.model).toBe('free/model:free')
    expect(lines).toEqual(['[summary] backend=mock model=free/model:free'])
  })
})
