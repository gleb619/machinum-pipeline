import { describe, expect, it } from 'vitest'
import type { Settings } from '../src/settings.js'
import type { Source, Target } from '../src/types.js'
import { MAX_URI_ALIAS_DEPTH, UriRegistry } from '../src/uri.js'

function makeRegistry(): UriRegistry {
  const r = new UriRegistry()
  const sourceFactory = (uri: { raw: string }): Source<unknown> => ({
    uri: uri.raw,
    lifestyle: 'resumable',
    async *start() {
      yield { item: uri.raw, meta: {} }
    },
  })
  const targetFactory = (uri: { raw: string }): Target<unknown> => ({
    uri: uri.raw,
    async open() {},
    async write() {},
    async close() {},
  })
  r.registerSource('md', sourceFactory)
  r.registerTarget('md', targetFactory)
  r.registerSource('jsonl', sourceFactory)
  r.registerTarget('chapter-output', targetFactory)
  return r
}

const settingsWith = (uris: Record<string, string>): Settings => ({ uris })

describe('URI alias resolution', () => {
  it('resolves an alias to its configured URI', () => {
    const r = makeRegistry()
    const settings = settingsWith({ en: 'md://./chapters/en' })
    expect(r.expandAliases('en', settings)).toBe('md://./chapters/en')
    expect(r.resolveTarget('en', settings).uri).toBe('md://./chapters/en')
    expect(r.resolveSource('en', settings).uri).toBe('md://./chapters/en')
  })

  it('resolves alias chains (a → b → URI)', () => {
    const r = makeRegistry()
    const settings = settingsWith({ a: 'b', b: 'md://./out' })
    expect(r.expandAliases('a', settings)).toBe('md://./out')
  })

  it('passes through real URIs unchanged', () => {
    const r = makeRegistry()
    const settings = settingsWith({ en: 'md://./chapters/en' })
    expect(r.expandAliases('md://./direct', settings)).toBe('md://./direct')
    expect(r.expandAliases('jsonl://./in.jsonl', settings)).toBe('jsonl://./in.jsonl')
  })

  it('throws a clear error for an unknown alias, naming the alias and mt.json', () => {
    const r = makeRegistry()
    expect(() => r.expandAliases('nope', settingsWith({ en: 'md://./x' }))).toThrow(
      /Unknown URI alias 'nope'.*mt\.json/s,
    )
  })

  it('unknown alias error also fires when no aliases are configured at all', () => {
    const r = makeRegistry()
    expect(() => r.expandAliases('nope', {})).toThrow(/Unknown URI alias 'nope'/)
    expect(() => r.expandAliases('nope', undefined)).toThrow(/Unknown URI alias 'nope'/)
  })

  it('throws a clear error for circular aliases', () => {
    const r = makeRegistry()
    const settings = settingsWith({ a: 'b', b: 'a' })
    expect(() => r.expandAliases('a', settings)).toThrow(/Circular URI alias.*a.*b.*a/s)
  })

  it('detects self-referencing circular aliases', () => {
    const r = makeRegistry()
    expect(() => r.expandAliases('a', settingsWith({ a: 'a' }))).toThrow(/Circular URI alias/)
  })

  it('caps alias chain depth', () => {
    const r = makeRegistry()
    const uris: Record<string, string> = {}
    for (let i = 0; i <= MAX_URI_ALIAS_DEPTH; i++) {
      uris[`a${i}`] = i === MAX_URI_ALIAS_DEPTH ? 'md://./out' : `a${i + 1}`
    }
    expect(() => r.expandAliases('a0', settingsWith(uris))).toThrow(/URI alias chain exceeds/s)
  })

  it('registered scheme wins over a colliding alias key', () => {
    const r = makeRegistry()
    const settings = settingsWith({ md: 'jsonl://./should-not-be-used' })
    // 'md://...' has a scheme separator — never an alias
    expect(r.expandAliases('md://./direct', settings)).toBe('md://./direct')
    expect(r.resolveSource('md://./direct', settings).uri).toBe('md://./direct')
  })

  it('scheme:path form wins over alias when the scheme is registered', () => {
    const r = makeRegistry()
    const settings = settingsWith({ 'md:./x': 'jsonl://./should-not-be-used' })
    expect(r.expandAliases('md:./x', settings)).toBe('md:./x')
  })

  it('non-string alias values are ignored', () => {
    const r = makeRegistry()
    const settings: Settings = { uris: { bad: 42 as unknown as string, en: 'md://./ok' } }
    expect(r.expandAliases('en', settings)).toBe('md://./ok')
    expect(() => r.expandAliases('bad', settings)).toThrow(/Unknown URI alias 'bad'/)
  })

  it('resolveSource/resolveTarget still throw for unknown schemes', () => {
    const r = makeRegistry()
    expect(() => r.resolveSource('nope://./x', {})).toThrow(/No source registered for scheme: nope/)
    expect(() => r.resolveTarget('nope://./x', {})).toThrow(/No target registered for scheme: nope/)
  })
})
