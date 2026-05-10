import { afterEach, describe, expect, it } from 'vitest'
import { createJsonlSource, createJsonlTarget } from '../../src/jsonl.js'
import type { Source, Target } from '@mt/core'
import { registry } from '@mt/core'

// Register on import
import '../../src/jsonl.js'

describe('UC-21 — JSONL Source (architectural)', () => {
  it('createJsonlSource is exported as a function', () => {
    expect(typeof createJsonlSource).toBe('function')
  })

  it('createJsonlSource returns an object satisfying Source interface', () => {
    const src = createJsonlSource({
      scheme: 'jsonl',
      raw: 'jsonl://./test.jsonl',
      path: './test.jsonl',
      query: {},
    })
    expect(src).toHaveProperty('uri')
    expect(src).toHaveProperty('lifestyle')
    expect(src.lifestyle).toBe('resumable')
    expect(typeof src.start).toBe('function')
    expect(typeof src.resume).toBe('function')
  })

  it('jsonl scheme is registered for source resolution', () => {
    const src = registry.resolveSource('jsonl://./data.jsonl')
    expect(src).toHaveProperty('uri')
    expect(src.uri).toBe('jsonl://./data.jsonl')
    expect(src.lifestyle).toBe('resumable')
  })
})

describe('UC-25 — JSONL Target (architectural)', () => {
  it('createJsonlTarget is exported as a function', () => {
    expect(typeof createJsonlTarget).toBe('function')
  })

  it('createJsonlTarget returns an object satisfying Target interface', () => {
    const tgt = createJsonlTarget({
      scheme: 'jsonl',
      raw: 'jsonl://./out.jsonl',
      path: './out.jsonl',
      query: {},
    })
    expect(tgt).toHaveProperty('uri')
    expect(tgt.uri).toBe('jsonl://./out.jsonl')
    expect(typeof tgt.open).toBe('function')
    expect(typeof tgt.write).toBe('function')
    expect(typeof tgt.close).toBe('function')
  })

  it('jsonl scheme is registered for target resolution', () => {
    const tgt = registry.resolveTarget('jsonl://./out.jsonl')
    expect(tgt).toHaveProperty('uri')
    expect(typeof tgt.open).toBe('function')
    expect(typeof tgt.close).toBe('function')
  })
})
