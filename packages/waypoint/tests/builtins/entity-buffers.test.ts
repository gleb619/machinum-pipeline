import type { Envelope, SourceContext } from '@mt/core'
import { registry } from '@mt/core'
import { describe, expect, it } from 'vitest'
import {
  ENTITY_BUFFER_SCHEMES,
  LADDER_BUFFER_SCHEMES,
  PACKAGE_BUFFER_SCHEMES,
} from '../../src/entity-buffers.js'

const ctx = {
  run: { global: { project: { name: 'test', root: '/tmp' }, settings: {} } },
} as unknown as SourceContext

async function collect<T>(iterable: AsyncIterable<Envelope<T>>): Promise<Envelope<T>[]> {
  const out: Envelope<T>[] = []
  for await (const env of iterable) out.push(env)
  return out
}

async function write<T>(uri: string, items: T[]): Promise<void> {
  const target = registry.resolveTarget<T>(uri)
  await target.open({} as never)
  for (const item of items) await target.write({ item, meta: {} }, {} as never)
  await target.close({} as never)
}

async function read<T>(uri: string): Promise<T[]> {
  const source = registry.resolveSource<T>(uri)
  return (await collect(source.start(ctx))).map((env) => env.item)
}

describe('entity buffer schemes', () => {
  it.each(LADDER_BUFFER_SCHEMES)('%s:// is a source-only ladder rung', (scheme) => {
    expect(registry.hasSource(scheme)).toBe(true)
    expect(registry.hasTarget(scheme)).toBe(false)
    expect(() => registry.resolveTarget(`${scheme}://`)).toThrow(
      `No target registered for scheme: ${scheme}`,
    )
  })

  it.each(PACKAGE_BUFFER_SCHEMES)('%s:// stays a bidirectional package buffer', (scheme) => {
    expect(registry.hasSource(scheme)).toBe(true)
    expect(registry.hasTarget(scheme)).toBe(true)
  })

  it('temp:// is target-only', () => {
    expect(registry.hasSource('temp')).toBe(false)
    expect(registry.hasTarget('temp')).toBe(true)
  })

  it('temp://<entity>/<namespace> writes the buffer the typed rung reads', async () => {
    await write('temp://chunks/ladder', ['chunk-1', 'chunk-2'])

    expect(await read('chunks://ladder')).toEqual(['chunk-1', 'chunk-2'])
  })

  it('temp://<entity> writes the default namespace', async () => {
    await write('temp://paragraphs', ['paragraph'])

    expect(await read('paragraphs://')).toEqual(['paragraph'])
  })

  it('keeps namespaces isolated', async () => {
    await write('temp://lines/a', ['line-a'])
    await write('temp://lines/b', ['line-b'])

    expect(await read('lines://a')).toEqual(['line-a'])
    expect(await read('lines://b')).toEqual(['line-b'])
  })

  it('keeps entity schemes isolated from each other and from ephemeral://', async () => {
    await write('temp://words/isolated', ['word'])
    await write('temp://paragraphs/isolated', [])
    await write('ephemeral://words', ['ephemeral-word'])

    expect(await read('paragraphs://isolated')).toEqual([])
    expect(await read('ephemeral://words')).toEqual(['ephemeral-word'])
  })

  it('keeps chunks:// isolated from lines://, paragraphs:// and ephemeral://chunks', async () => {
    await write('temp://lines/isolated', ['line'])
    await write('temp://paragraphs/isolated', ['paragraph'])
    await write('temp://chunks/isolated', ['chunk'])
    await write('ephemeral://chunks', ['ephemeral-chunk'])

    expect(await read('chunks://isolated')).toEqual(['chunk'])
    expect(await read('lines://isolated')).toEqual(['line'])
    expect(await read('paragraphs://isolated')).toEqual(['paragraph'])
    expect(await read('ephemeral://chunks')).toEqual(['ephemeral-chunk'])
  })

  it('clears the buffer when the target opens', async () => {
    await write('temp://chapters/isolated', ['old'])
    await write('temp://chapters/isolated', ['new'])

    expect(await read('chapters://isolated')).toEqual(['new'])
  })

  it('round-trips tokens:// and keeps it isolated from chunks:// and ephemeral://tokens', async () => {
    await write('temp://chunks/isolated', ['chunk'])
    await write('temp://tokens/isolated', [{ tokenId: 1 }, { tokenId: 2 }])

    expect(await read<{ tokenId: number }>('tokens://isolated')).toEqual([
      { tokenId: 1 },
      { tokenId: 2 },
    ])
    expect(await read('chunks://isolated')).toEqual(['chunk'])
    expect(await read('ephemeral://tokens')).toEqual([])
  })

  it('rejects temp:// without an entity scheme', () => {
    expect(() => registry.resolveTarget('temp:///ladder')).toThrow('temp:// needs an entity scheme')
  })

  it('rejects an unknown entity scheme', () => {
    expect(() => registry.resolveTarget('temp://foo/ladder')).toThrow(
      "Unknown entity buffer scheme 'foo'",
    )
  })

  it('rejects a multi-segment temp:// namespace', () => {
    expect(() => registry.resolveTarget('temp://chunks/a/b')).toThrow(
      'temp:// namespace must be a single segment',
    )
  })

  it('exposes every entity scheme as a temp:// target', async () => {
    for (const scheme of ENTITY_BUFFER_SCHEMES) {
      await write(`temp://${scheme}/every`, [`${scheme}-item`])
      expect(await read(`${scheme}://every`)).toEqual([`${scheme}-item`])
    }
  })
})
