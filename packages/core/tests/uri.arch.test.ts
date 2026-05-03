import { describe, expect, it } from 'vitest'
import { source, target } from '../src/dsl.js'
import type { Envelope, Source, SourceContext, Target, TargetContext } from '../src/index.js'
import { registry } from '../src/uri.js'

// Register builtins for URI resolution
import '../src/builtins/jsonl-source.js'

describe('UC-04 — Define custom Source/Target (architectural)', () => {
  it('Source<T> conforms to interface shape', () => {
    const src: Source<unknown> = {
      uri: 'mock://test-source',
      lifestyle: { type: 'request-response' },
      start: async function* (_ctx: SourceContext) {
        yield { item: {}, meta: {} } as Envelope<unknown>
      },
    }

    expect(src.uri).toBe('mock://test-source')
    expect(src.lifestyle).toBeDefined()
    expect(typeof src.start).toBe('function')
  })

  it('Target<T> conforms to interface shape', () => {
    const tgt: Target<unknown> = {
      uri: 'mock://test-target',
      open: async (_ctx: TargetContext) => {},
      write: async (_env, _ctx: TargetContext) => {},
      close: async (_ctx: TargetContext) => {},
    }

    expect(tgt.uri).toBe('mock://test-target')
    expect(typeof tgt.open).toBe('function')
    expect(typeof tgt.write).toBe('function')
    expect(typeof tgt.close).toBe('function')
  })

  it('registry.resolveSource throws for unknown scheme', () => {
    expect(() => registry.resolveSource('unknown-scheme-xyz://test')).toThrow()
  })

  it('registry.resolveTarget throws for unknown scheme', () => {
    expect(() => registry.resolveTarget('unknown-scheme-xyz://test')).toThrow()
  })

  it('source() helper resolves a registered scheme', () => {
    const s = source<unknown>('jsonl://./test.jsonl')
    expect(s).toBeDefined()
    expect(typeof s.uri).toBe('string')
  })

  it('target() helper resolves a registered scheme', () => {
    const t = target<unknown>('jsonl://./test.jsonl')
    expect(t).toBeDefined()
    expect(typeof t.uri).toBe('string')
  })
})
