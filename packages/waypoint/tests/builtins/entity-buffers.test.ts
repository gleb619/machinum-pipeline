import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { BufferWriter, Envelope, GlobalContext, SourceContext } from '@mt/core'
import { Runner, createExchange, definePipeline, registry } from '@mt/core'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  ENTITY_BUFFER_SCHEMES,
  LADDER_BUFFER_SCHEMES,
  PACKAGE_BUFFER_SCHEMES,
} from '../../src/entity-buffers.js'
import { createEphemeralTarget } from '../../src/ephemeral.js'

const ctx = {
  run: { global: { project: { name: 'test', root: '/tmp' }, settings: {} } },
} as unknown as SourceContext

async function collect<T>(iterable: AsyncIterable<Envelope<T>>): Promise<Envelope<T>[]> {
  const out: Envelope<T>[] = []
  for await (const env of iterable) out.push(env)
  return out
}

async function read<T>(uri: string): Promise<T[]> {
  const source = registry.resolveSource<T>(uri)
  return (await collect(source.start(ctx))).map((env) => env.item)
}

function writer(scheme: (typeof ENTITY_BUFFER_SCHEMES)[number], namespace: string): BufferWriter {
  return registry.resolveBufferWriter(scheme, namespace)
}

function fill(target: BufferWriter, items: unknown[]): void {
  target.reset()
  for (const item of items) target.append(createExchange(item))
}

// Fake source + splitter for the auto-publish integration tests. The splitter is
// registered under `chunks` only in this isolated test file.
let sourceItems: unknown[] = []
registry.registerSource('entity-buffers-source', (uri) => ({
  uri: uri.raw,
  lifestyle: 'resumable' as const,
  async *start() {
    for (const item of sourceItems) yield { item }
  },
  async *resume() {
    for (const item of sourceItems) yield { item }
  },
}))
const testSplitter = {
  name: 'entity-buffers-test-splitter',
  split(env: Envelope<unknown>) {
    return [`${env.item}-a`, `${env.item}-b`]
  },
}
registry.registerSplitter('chunks', testSplitter)

function globalContext(root: string): GlobalContext {
  return {
    project: { name: 'test', root },
    defaults: {
      retry: { max: 0, backoffMs: 0, strategy: 'fixed' },
      onError: 'fail-run',
      concurrency: 1,
    },
    settings: {},
    env: {},
  }
}

function autoPublishPipeline(namespace?: string) {
  const flow = definePipeline({ id: 'entity-buffers-auto-publish' }).from(
    'entity-buffers-source://in',
  )
  return namespace === undefined ? flow.subflow('#chunks') : flow.subflow('#chunks', namespace)
}

describe('entity buffer schemes', () => {
  let root: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'entity-buffers-'))
    sourceItems = ['one', 'two']
    for (const scheme of ENTITY_BUFFER_SCHEMES) {
      for (const namespace of ['default', 'ladder', 'isolated', 'every']) {
        fill(writer(scheme, namespace), [])
      }
    }
  })

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

  it('removed temp:// entirely', () => {
    expect(registry.hasSource('temp')).toBe(false)
    expect(registry.hasTarget('temp')).toBe(false)
    expect(() => registry.resolveTarget('temp://chunks/ladder')).toThrow(
      'No target registered for scheme: temp',
    )
  })

  it('auto-publishes a splitter subflow into the default namespace', async () => {
    await new Runner(autoPublishPipeline(), globalContext(root)).start()

    expect(await read('chunks://')).toEqual(['one-a', 'one-b', 'two-a', 'two-b'])
  })

  it('auto-publishes a splitter subflow into an explicit namespace', async () => {
    await new Runner(autoPublishPipeline('ladder'), globalContext(root)).start()

    expect(await read('chunks://ladder')).toEqual(['one-a', 'one-b', 'two-a', 'two-b'])
    expect(await read('chunks://')).toEqual([])
  })

  it('clears the buffer when the stage runs again', async () => {
    sourceItems = ['one']
    await new Runner(autoPublishPipeline('ladder'), globalContext(root)).start()
    await new Runner(autoPublishPipeline('ladder'), globalContext(root)).start()

    expect(await read('chunks://ladder')).toEqual(['one-a', 'one-b'])
  })

  it('keeps namespaces isolated', async () => {
    fill(writer('lines', 'a'), ['line-a'])
    fill(writer('lines', 'b'), ['line-b'])

    expect(await read('lines://a')).toEqual(['line-a'])
    expect(await read('lines://b')).toEqual(['line-b'])
  })

  it('keeps entity schemes isolated from each other and from ephemeral://', async () => {
    fill(writer('words', 'isolated'), ['word'])
    fill(writer('paragraphs', 'isolated'), [])
    const ephemeral = createEphemeralTarget<string>({
      raw: 'ephemeral://words',
      host: 'words',
      path: 'words',
      query: {},
    })
    await ephemeral.open({} as never)
    await ephemeral.write({ item: 'ephemeral-word', meta: {} }, {} as never)
    await ephemeral.close({} as never)

    expect(await read('paragraphs://isolated')).toEqual([])
    expect(await read('words://isolated')).toEqual(['word'])
    expect(await read('ephemeral://words')).toEqual(['ephemeral-word'])
  })

  it('keeps chunks:// isolated from lines://, paragraphs:// and ephemeral://chunks', async () => {
    fill(writer('lines', 'isolated'), ['line'])
    fill(writer('paragraphs', 'isolated'), ['paragraph'])
    fill(writer('chunks', 'isolated'), ['chunk'])

    expect(await read('chunks://isolated')).toEqual(['chunk'])
    expect(await read('lines://isolated')).toEqual(['line'])
    expect(await read('paragraphs://isolated')).toEqual(['paragraph'])
  })

  it('clears the buffer on reset', async () => {
    const target = writer('chapters', 'isolated')
    fill(target, ['old'])
    fill(target, ['new'])

    expect(await read('chapters://isolated')).toEqual(['new'])
  })

  it('round-trips tokens:// and keeps it isolated from chunks://', async () => {
    fill(writer('chunks', 'isolated'), ['chunk'])
    fill(writer('tokens', 'isolated'), [{ tokenId: 1 }, { tokenId: 2 }])

    expect(await read<{ tokenId: number }>('tokens://isolated')).toEqual([
      { tokenId: 1 },
      { tokenId: 2 },
    ])
    expect(await read('chunks://isolated')).toEqual(['chunk'])
  })

  it('exposes a buffer writer for every entity scheme', async () => {
    for (const scheme of ENTITY_BUFFER_SCHEMES) {
      expect(registry.hasBufferWriter(scheme)).toBe(true)
      fill(writer(scheme, 'every'), [`${scheme}-item`])
    }

    for (const scheme of ENTITY_BUFFER_SCHEMES) {
      expect(await read(`${scheme}://every`)).toEqual([`${scheme}-item`])
    }
  })

  it('rejects an unknown buffer scheme', () => {
    expect(() => registry.resolveBufferWriter('foo', 'ladder')).toThrow(
      'No buffer writer registered for scheme: foo',
    )
  })
})
