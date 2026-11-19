import { isProcess } from '@mt/core'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

let normalization: unknown
let preparation: unknown
let translation: unknown

function pipelineIds(runnable: unknown): string[] {
  if (!isProcess(runnable)) throw new Error('expected a process')
  return runnable.pipelines.map((pipeline) => pipeline.id)
}

beforeAll(async () => {
  vi.stubEnv('MT_LLM_TOOL', 'mock')
  vi.stubEnv('MT_ALLOW_MOCK', '1')
  normalization = (await import('../pipelines/normalization.js')).default
  preparation = (await import('../pipelines/preparation.js')).default
  translation = (await import('../pipelines/translation.js')).default
})

afterAll(() => {
  vi.unstubAllEnvs()
})

describe('pipeline phases', () => {
  it('groups the book flow into normalization, preparation and translation', () => {
    expect(pipelineIds(normalization)).toEqual([
      'practical-extract-en',
      'practical-stats',
      'practical-split',
    ])
    expect(pipelineIds(preparation)).toEqual([
      'practical-summary',
      'practical-ner',
      'practical-vocabulary',
      'practical-glossary',
      'practical-glossary-index',
      'practical-quality',
      'practical-preprocess',
    ])
    expect(pipelineIds(translation)).toEqual([
      'practical-translate-titles',
      'practical-translate-chapters',
      'practical-assemble',
    ])
  })

  it('keeps the phase processes sequential', () => {
    for (const phase of [normalization, preparation, translation]) {
      if (!isProcess(phase)) throw new Error('expected a process')
      expect(phase.mode).toBe('sync')
    }
  })
})
