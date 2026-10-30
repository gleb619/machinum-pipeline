import type { Envelope, ParsedUri, SourceContext } from '@mt/core'
import { registry } from '@mt/core'
import { describe, expect, it } from 'vitest'
import {
  ENTITY_BUFFER_SCHEMES,
  type EntityBufferScheme,
  createEntityBufferSource,
  createEntityBufferTarget,
} from '../../src/entity-buffers.js'

const ctx = {
  run: { global: { project: { name: 'test', root: '/tmp' }, settings: {} } },
} as unknown as SourceContext

function uriFor(scheme: EntityBufferScheme, namespace = ''): ParsedUri {
  const host = namespace
  return { scheme, raw: `${scheme}://${namespace}`, host, path: '', query: {} }
}

async function collect<T>(iterable: AsyncIterable<Envelope<T>>): Promise<Envelope<T>[]> {
  const out: Envelope<T>[] = []
  for await (const env of iterable) out.push(env)
  return out
}

async function write<T>(scheme: EntityBufferScheme, namespace: string, items: T[]): Promise<void> {
  const target = createEntityBufferTarget<T>(scheme, uriFor(scheme, namespace))
  await target.open({} as never)
  for (const item of items) await target.write({ item, meta: {} }, {} as never)
  await target.close({} as never)
}

describe('entity buffer schemes', () => {
  it.each(ENTITY_BUFFER_SCHEMES)('%s:// is registered as both source and target', (scheme) => {
    expect(registry.resolveSource(`${scheme}://`)).toHaveProperty('start')
    expect(registry.resolveTarget(`${scheme}://`)).toHaveProperty('write')
  })

  it('round-trips envelopes through the default namespace', async () => {
    await write('paragraphs', '', [1, 2, 3])

    const source = createEntityBufferSource<number>('paragraphs', uriFor('paragraphs'))
    const envelopes = await collect(source.start(ctx))

    expect(envelopes.map((env) => env.item)).toEqual([1, 2, 3])
  })

  it('keeps namespaces isolated', async () => {
    await write('lines', 'a', ['line-a'])
    await write('lines', 'b', ['line-b'])

    const sourceA = createEntityBufferSource<string>('lines', uriFor('lines', 'a'))
    const sourceB = createEntityBufferSource<string>('lines', uriFor('lines', 'b'))

    expect((await collect(sourceA.start(ctx))).map((env) => env.item)).toEqual(['line-a'])
    expect((await collect(sourceB.start(ctx))).map((env) => env.item)).toEqual(['line-b'])
  })

  it('keeps entity schemes isolated from each other and from ephemeral://', async () => {
    await write('words', '', ['word'])
    await write('paragraphs', '', [])

    const paragraphs = createEntityBufferSource<string>('paragraphs', uriFor('paragraphs'))
    expect(await collect(paragraphs.start(ctx))).toEqual([])

    const ephemeral = registry.resolveSource<string>('ephemeral://words')
    expect(await collect(ephemeral.start(ctx))).toEqual([])
  })

  it('clears the buffer when the target opens', async () => {
    await write('chapters', '', ['old'])
    await write('chapters', '', ['new'])

    const source = createEntityBufferSource<string>('chapters', uriFor('chapters'))
    expect((await collect(source.start(ctx))).map((env) => env.item)).toEqual(['new'])
  })
})
