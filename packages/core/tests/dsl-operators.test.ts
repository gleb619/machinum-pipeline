import { beforeAll, describe, expect, it } from 'vitest'
import { definePipeline, source, target } from '../src/dsl.js'
import type { Pipeline } from '../src/types.js'
import type { ParsedUri } from '../src/uri.js'
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

    expect(pipeline.steps.find((s) => s.type === 'fork')?.config.pipeline).toBeDefined()
  })
})

describe('DSL Operators: batch/window size validation', () => {
  it('rejects non-positive, non-integer, and NaN sizes', () => {
    const pipeline = definePipeline({ id: 'size-validation' })

    expect(() => pipeline.batch(0)).toThrow(RangeError)
    expect(() => pipeline.batch(-1)).toThrow(RangeError)
    expect(() => pipeline.batch(1.5)).toThrow(RangeError)
    expect(() => pipeline.batch(Number.NaN)).toThrow(RangeError)
    expect(() => pipeline.window(0)).toThrow(RangeError)
    expect(() => pipeline.window(-1)).toThrow(RangeError)
    expect(() => pipeline.window(Number.NaN)).toThrow(RangeError)
  })

  it('accepts positive integer sizes', () => {
    const pipeline = definePipeline({ id: 'size-validation-ok' }).batch(3).window(2)

    expect(pipeline.steps.map((s) => s.type)).toEqual(['batch', 'window'])
  })
})
