import { beforeAll, describe, expect, it } from 'vitest'
import { DEFAULT_BATCH_SIZE, definePipeline, source, target } from '../src/dsl.js'
import type { Pipeline } from '../src/types.js'
import type { ParsedUri } from '../src/types.js'
import { registry } from '../src/uri.js'

beforeAll(() => {
  registry.registerSource('jsonl', (uri: ParsedUri) => ({
    uri: uri.raw,
    lifestyle: 'resumable',
    async *start() {
      yield { item: {}, meta: {} }
    },
    async *resume() {
      yield { item: {}, meta: {} }
    },
  }))
  registry.registerTarget('jsonl', (uri: ParsedUri) => ({
    uri: uri.raw,
    async open() {},
    async write() {},
    async close() {},
  }))
})

describe('DSL Operators: flatMap, fork, tap', () => {
  it('should construct a pipeline with new operators', async () => {
    const forkPipeline = definePipeline({
      id: 'fork-pipeline',
      retry: { max: 0, backoffMs: 0, strategy: 'fixed' },
      onError: 'fail-run',
    })
      .from(source('jsonl://in.jsonl'))
      .to(target('jsonl://out.jsonl'))

    const pipeline: Pipeline = definePipeline({
      id: 'main-pipeline',
      retry: { max: 1, backoffMs: 100, strategy: 'fixed' },
      onError: 'fail-run',
    })
      .from(source('jsonl://book.jsonl'))
      .tap(async (item) => {
        console.log('Tap', item)
      })
      .flatMap(async (item) => [item, item])
      .fork(forkPipeline)
      .to(target('jsonl://final.jsonl'))

    expect(pipeline.steps.map((s) => s.type)).toEqual([
      'source',
      'tap',
      'flatmap',
      'fork',
      'target',
    ])

    const forkConfig = pipeline.steps.find((s) => s.type === 'fork')?.config
    expect(forkConfig?.pipeline).toBe(forkPipeline)
    expect(forkConfig).not.toHaveProperty('parallel')
  })

  it('should push exactly one parallel fork step for named branches', () => {
    const branchA = definePipeline({ id: 'branch-a' }).from(source('jsonl://a.jsonl'))
    const branchB = definePipeline({ id: 'branch-b' }).from(source('jsonl://b.jsonl'))

    const pipeline = definePipeline({ id: 'parallel-fork' }).fork('views', [branchA, branchB])
    const forkSteps = pipeline.steps.filter((step) => step.type === 'fork')

    expect(forkSteps).toHaveLength(1)
    const config = forkSteps[0]?.config
    expect(config?.name).toBe('views')
    expect(config?.pipelines).toEqual([branchA, branchB])
    expect(config?.parallel).toBe(true)
    expect(config).not.toHaveProperty('pipeline')
  })

  it('validates the parallel fork name and branches at definition time', () => {
    const branch = definePipeline({ id: 'branch' })

    expect(() => definePipeline().fork('', [branch])).toThrow(TypeError)
    expect(() => definePipeline().fork('   ', [branch])).toThrow(TypeError)
    expect(() => definePipeline().fork('views', [])).toThrow(TypeError)
    expect(() =>
      definePipeline().fork('views', [{ id: 'invalid', steps: 'nope' } as unknown as Pipeline]),
    ).toThrow(TypeError)
  })
})

describe('DSL Operators: batch options + size validation', () => {
  it('rejects non-positive, non-integer, and NaN sizes (number and object form)', () => {
    const pipeline = definePipeline({ id: 'size-validation' })

    expect(() => pipeline.batch(0)).toThrow(RangeError)
    expect(() => pipeline.batch(-1)).toThrow(RangeError)
    expect(() => pipeline.batch(1.5)).toThrow(RangeError)
    expect(() => pipeline.batch(Number.NaN)).toThrow(RangeError)
    expect(() => pipeline.batch({ size: 0 })).toThrow(RangeError)
    expect(() => pipeline.batch({ size: Number.NaN, slide: true })).toThrow(RangeError)
  })

  it('defaults to size 5, tumbling', () => {
    const pipeline = definePipeline({ id: 'batch-default' }).batch()

    expect(pipeline.steps[0]?.config).toEqual({ size: 5, slide: false })
    expect(DEFAULT_BATCH_SIZE).toBe(5)
  })

  it('accepts number and options object; slide survives only as an option', () => {
    const pipeline = definePipeline({ id: 'size-validation-ok' })
      .batch(3)
      .batch({ size: 2, slide: true })
      .batch({})

    expect(pipeline.steps.map((s) => s.config)).toEqual([
      { size: 3, slide: false },
      { size: 2, slide: true },
      { size: 5, slide: false },
    ])
    expect('window' in pipeline).toBe(false)
    expect('unbatch' in pipeline).toBe(false)
  })

  it('stores the nested scope pipeline; slide + nested is rejected', () => {
    const nested = definePipeline({ id: 'nested' })
    const pipeline = definePipeline({ id: 'scoped' }).batch({ size: 2 }, nested)

    expect(pipeline.steps[0]?.config.pipeline).toBe(nested)
    expect(() => definePipeline().batch({ slide: true }, nested)).toThrow(RangeError)
  })
})
