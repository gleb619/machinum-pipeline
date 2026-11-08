import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { definePipeline } from '../../src/dsl.js'
import { Runner } from '../../src/engine/runner.js'
import type { BufferWriter, Splitter } from '../../src/types.js'
import type { GlobalContext } from '../../src/types.js'
import { registry } from '../../src/uri.js'

/** Namespace -> published items, shared by the fake writer. */
const buffers = new Map<string, unknown[]>()
const resets: string[] = []
let sourceItems: unknown[] = []

registry.registerSource('autopublish-source', (uri) => ({
  uri: uri.raw,
  lifestyle: 'resumable' as const,
  async *start() {
    for (const item of sourceItems) yield { item }
  },
  async *resume() {
    for (const item of sourceItems) yield { item }
  },
}))

const splitter: Splitter<string> = {
  name: 'test-buffer-splitter',
  split(env) {
    return [`${env.item}-a`, `${env.item}-b`]
  },
}

registry.registerSplitter('test-buffer', splitter)
registry.registerBufferWriter(
  'test-buffer',
  (namespace): BufferWriter => ({
    reset() {
      resets.push(namespace)
      buffers.set(namespace, [])
    },
    append(env) {
      buffers.get(namespace)?.push(env.item)
    },
  }),
)

function ctx(root: string): GlobalContext {
  return {
    project: { name: 't', root },
    defaults: {
      retry: { max: 0, backoffMs: 0, strategy: 'fixed' },
      onError: 'fail-run',
      concurrency: 1,
    },
    settings: {},
    env: {},
  }
}

const pipeline = (namespace?: string) => {
  const flow = definePipeline({ id: 'autopublish' }).from('autopublish-source://in')
  return namespace === undefined
    ? flow.subflow('#test-buffer')
    : flow.subflow('#test-buffer', namespace)
}

describe('splitter subflow auto-publish', () => {
  let root: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'mt-autopublish-'))
    buffers.clear()
    resets.length = 0
    sourceItems = ['one', 'two']
  })

  it('publishes into the default namespace', async () => {
    await new Runner(pipeline(), ctx(root)).start()

    expect(buffers.get('default')).toEqual(['one-a', 'one-b', 'two-a', 'two-b'])
  })

  it('publishes into an explicit namespace', async () => {
    await new Runner(pipeline('ladder'), ctx(root)).start()

    expect(buffers.get('ladder')).toEqual(['one-a', 'one-b', 'two-a', 'two-b'])
    expect(buffers.has('default')).toBe(false)
  })

  it('clears the buffer when the stage runs again', async () => {
    await new Runner(pipeline('ladder'), ctx(root)).start()
    await new Runner(pipeline('ladder'), ctx(root)).start()

    expect(resets).toEqual(['ladder', 'ladder'])
    expect(buffers.get('ladder')).toEqual(['one-a', 'one-b', 'two-a', 'two-b'])
  })
})
