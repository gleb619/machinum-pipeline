import { beforeAll, describe, expect, it } from 'vitest'
import { createJsonlSource, createJsonlTarget } from '../src/builtins/jsonl-source.js'
import { definePipeline, source, target } from '../src/dsl.js'
import type { Pipeline } from '../src/types.js'
import { registry } from '../src/uri.js'

beforeAll(() => {
  registry.registerSource('jsonl', createJsonlSource)
  registry.registerTarget('jsonl', createJsonlTarget)
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
