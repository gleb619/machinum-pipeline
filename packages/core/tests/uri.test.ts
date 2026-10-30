import { describe, expect, it } from 'vitest'
import type { ParsedUri } from '../src/uri.js'
import { UriRegistry, registry } from '../src/uri.js'

describe('UriRegistry', () => {
  it('parses a simple URI', () => {
    const parsed = registry.parse('jsonl://./file.jsonl?batchSize=5')
    expect(parsed.scheme).toBe('jsonl')
    expect(parsed.host).toBe('')
    expect(parsed.path).toBe('./file.jsonl')
    expect(parsed.query.batchSize).toBe('5')
  })

  it('parses a URI with host', () => {
    const parsed = registry.parse('http://localhost:7000/in?path=/chapter')
    expect(parsed.scheme).toBe('http')
    expect(parsed.host).toBe('localhost:7000')
    expect(parsed.path).toBe('/in')
    expect(parsed.query.path).toBe('/chapter')
  })

  it('parses a URI with fragment', () => {
    const parsed = registry.parse('jsonl://./file.jsonl#section1')
    expect(parsed.scheme).toBe('jsonl')
    expect(parsed.fragment).toBe('section1')
  })

  it('returns raw URI', () => {
    const uri = 'jsonl://./test.jsonl'
    const parsed = registry.parse(uri)
    expect(parsed.raw).toBe(uri)
  })

  it('throws on invalid URI', () => {
    expect(() => registry.parse('not-a-uri')).toThrow('Invalid URI')
  })

  it('keeps values containing extra equals signs', () => {
    const parsed = registry.parse('jsonl://x?k=a=b')
    expect(parsed.query.k).toBe('a=b')
  })

  it('does not throw a bare URIError for a lone percent sign', () => {
    const parsed = registry.parse('jsonl://x?p=100%')
    expect(parsed.query.p).toBe('100%')
  })

  it('parses a valueless flag query parameter as an empty string', () => {
    const parsed = registry.parse('jsonl://x?flag')
    expect(parsed.query.flag).toBe('')
  })

  it('decodes an encoded equals sign in a query value', () => {
    const parsed = registry.parse('jsonl://x?k=a%3Db')
    expect(parsed.query.k).toBe('a=b')
  })

  it('keeps equals signs in later query values', () => {
    const parsed = registry.parse('jsonl://x?a=1&b=2=3')
    expect(parsed.query.a).toBe('1')
    expect(parsed.query.b).toBe('2=3')
  })

  it('registers and resolves a source', () => {
    const testRegistry = new UriRegistry()
    const factory = (parsed: ParsedUri) => ({
      uri: parsed.raw,
      lifestyle: 'resumable' as const,
      start: async function* () {},
    })

    testRegistry.registerSource('test', factory)
    const source = testRegistry.resolveSource('test://path')
    expect(source.uri).toBe('test://path')
    expect(source.lifestyle).toBe('resumable')
  })

  it('throws when resolving unregistered source scheme', () => {
    expect(() => registry.resolveSource('unknown://test')).toThrow(
      'No source registered for scheme: unknown',
    )
  })

  it('registers and resolves a target', () => {
    const testRegistry = new UriRegistry()
    const factory = (parsed: ParsedUri) => ({
      uri: parsed.raw,
      open: async () => {},
      write: async () => {},
      close: async () => {},
    })

    testRegistry.registerTarget('test-target', factory)
    const target = testRegistry.resolveTarget('test-target://path')
    expect(target.uri).toBe('test-target://path')
  })

  it('reports registered schemes', () => {
    const testRegistry = new UriRegistry()
    expect(testRegistry.getSourceSchemes()).toEqual([])
    testRegistry.registerSource('jsonl', () => ({
      uri: '',
      lifestyle: 'resumable' as const,
      start: async function* () {},
    }))
    expect(testRegistry.getSourceSchemes()).toContain('jsonl')
  })
})
