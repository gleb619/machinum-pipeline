import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { definePipeline } from '../../src/dsl.js'
import { Runner } from '../../src/engine/runner.js'
import type { Envelope, GlobalContext, Splitter, Target } from '../../src/types.js'
import { registry } from '../../src/uri.js'

let sourceItems: unknown[] = []
const childItems: unknown[] = []
const parentItems: unknown[] = []
let voidCount = 0

registry.registerSource('split-source', (uri) => ({
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
  name: 'test-split-splitter',
  split(env) {
    return [`${env.item}-a`, `${env.item}-b`]
  },
}
registry.registerSplitter('split-flow-entities', splitter)

/** Collecting target used as both the child pipe target and the parent passthrough sink. */
function collectingTarget(scheme: string, sink: unknown[]): void {
  registry.registerTarget(
    scheme,
    (uri): Target<unknown> => ({
      uri: uri.raw,
      async open() {
        sink.length = 0
      },
      async write(env: Envelope<unknown>) {
        sink.push(env.item)
      },
      async close() {},
    }),
  )
}
collectingTarget('split-child-collect', childItems)
collectingTarget('split-parent-collect', parentItems)

// `void://` is registered by @mt/waypoint in real runs; core tests get a counting stub.
registry.registerTarget(
  'void',
  (uri): Target<unknown> => ({
    uri: uri.raw,
    async open() {
      voidCount = 0
    },
    async write() {
      voidCount += 1
    },
    async close() {},
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

describe('split-form subflow runner', () => {
  let root: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'mt-split-subflow-'))
    childItems.length = 0
    parentItems.length = 0
    sourceItems = ['one', 'two']
  })

  it('passes the parent stream through unchanged and feeds split items to the pipe target', async () => {
    const pipeline = definePipeline({ id: 'split-subflow' })
      .from('split-source://in')
      .subflow(
        'split-flow-entities://',
        definePipeline({ id: 'split-child' }).to('split-child-collect://out'),
      )
      .to('split-parent-collect://out')

    await new Runner(pipeline, ctx(root)).start()

    expect(parentItems).toEqual(['one', 'two'])
    expect(childItems).toEqual(['one-a', 'one-b', 'two-a', 'two-b'])
  })

  it('injects a void:// target when the child pipeline has none', async () => {
    const pipeline = definePipeline({ id: 'split-void' })
      .from('split-source://in')
      .subflow('split-flow-entities://', definePipeline({ id: 'void-child' }))

    const steps = (
      pipeline.steps.find((s) => s.type === 'split')?.config.pipeline as { steps: unknown[] }
    ).steps
    expect(steps[steps.length - 1]).toEqual({ type: 'target', config: { uri: 'void://' } })

    await new Runner(pipeline, ctx(root)).start()
    // 4 envelopes go to the child's void target, the 2 parent envelopes to the root
    // pipeline's default void target (the root has a source but no target).
    expect(voidCount).toBe(6)
    expect(parentItems).toEqual([])
  })
})
