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

describe('UC-51 — Composite URI Resolution (architectural)', () => {
  it('registry.registerComposite is a function', () => {
    expect(typeof registry.registerComposite).toBe('function')
  })

  it('registerComposite accepts a prefix and resolver function', () => {
    const resolver = (schemes: string[], rest: string) => ({
      scheme: 'inner',
      host: '',
      path: `/${schemes.join('+')}${rest}`,
      query: {},
      fragment: '',
      raw: '',
    })
    expect(() => registry.registerComposite('test+composite', resolver)).not.toThrow()
  })

  it('composite resolver is invoked for matching prefix', () => {
    let wasCalled = false
    const resolver = (_schemes: string[], rest: string) => {
      wasCalled = true
      return registry.parse(`http://example.com${rest}`)
    }
    registry.registerComposite('wrapper+http', resolver)
    registry.parse('wrapper+http://example.com/data')
    expect(wasCalled).toBe(true)
  })

  it('composite resolver receives schemes array from prefix split on +', () => {
    let received: string[] = []
    const resolver = (schemes: string[], _rest: string) => {
      received = schemes
      return { scheme: 'inner', host: '', path: '', query: {}, fragment: '', raw: '' }
    }
    registry.registerComposite('a+b+c', resolver)
    registry.parse('a+b+c://foo')
    expect(received).toEqual(['a', 'b', 'c'])
  })

  it('composite resolver receives rest string after prefix', () => {
    let restReceived = ''
    const resolver = (_schemes: string[], rest: string) => {
      restReceived = rest
      return { scheme: 'inner', host: '', path: '', query: {}, fragment: '', raw: '' }
    }
    registry.registerComposite('foo+', resolver)
    registry.parse('foo+bar://baz?q=1')
    expect(restReceived).toBe('bar://baz?q=1')
  })

  it('parse falls through to standard parsing when no composite matches', () => {
    const result = registry.parse('jsonl://./data.jsonl?limit=10')
    expect(result.scheme).toBe('jsonl')
    expect(result.path).toBe('./data.jsonl')
    expect(result.query).toEqual({ limit: '10' })
  })

  it('getSourceSchemes returns array', () => {
    const schemes = registry.getSourceSchemes()
    expect(Array.isArray(schemes)).toBe(true)
  })
})
