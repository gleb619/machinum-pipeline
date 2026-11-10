import { beforeAll, describe, expect, it } from 'vitest'
import { DEFAULT_BATCH_SIZE, definePipeline, parseBatchUri, source, target } from '../src/dsl.js'
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
    const childPipeline = definePipeline({
      id: 'child-pipeline',
      retry: { max: 0, backoffMs: 0, strategy: 'fixed' },
      onError: 'fail-run',
    })

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
      .forkSync(childPipeline)
      .to(target('jsonl://final.jsonl'))

    expect(pipeline.steps.map((s) => s.type)).toEqual([
      'source',
      'tap',
      'flatmap',
      'fork',
      'target',
    ])

    const forkConfig = pipeline.steps.find((s) => s.type === 'fork')?.config
    expect(forkConfig?.pipeline).toBe(childPipeline)
    expect(forkConfig).not.toHaveProperty('parallel')
  })

  it('pushes exactly one parallel fork step for the branches', () => {
    const branchA = definePipeline({ id: 'branch-a' }).tap(async () => {})
    const branchB = definePipeline({ id: 'branch-b' }).tap(async () => {})

    const pipeline = definePipeline({ id: 'parallel-fork' }).fork(branchA, branchB)
    const forkSteps = pipeline.steps.filter((step) => step.type === 'fork')

    expect(forkSteps).toHaveLength(1)
    const config = forkSteps[0]?.config
    expect(config?.pipelines).toEqual([branchA, branchB])
    expect(config?.parallel).toBe(true)
    expect(config).not.toHaveProperty('pipeline')
    expect(config).not.toHaveProperty('name')
  })

  it('pushes one sequential fork step per .forkSync() branch', () => {
    const branchA = definePipeline({ id: 'branch-a' }).tap(async () => {})
    const branchB = definePipeline({ id: 'branch-b' }).tap(async () => {})

    const pipeline = definePipeline({ id: 'sync-fork' }).forkSync(branchA, branchB)
    const forkSteps = pipeline.steps.filter((step) => step.type === 'fork')

    expect(forkSteps).toHaveLength(2)
    expect(forkSteps[0]?.config.pipeline).toBe(branchA)
    expect(forkSteps[1]?.config.pipeline).toBe(branchB)
    expect(forkSteps[0]?.config).not.toHaveProperty('parallel')
  })

  it('validates fork branches at definition time', () => {
    const branch = definePipeline({ id: 'branch' })
    const withSource = definePipeline({ id: 'with-source' }).from(source('jsonl://a.jsonl'))

    expect(() => definePipeline().fork()).toThrow(TypeError)
    expect(() =>
      definePipeline().fork(branch, { id: 'invalid', steps: 'nope' } as unknown as Pipeline),
    ).toThrow(TypeError)
    expect(() => definePipeline().fork(withSource)).toThrow(/must not declare its own source/)
    expect(() => definePipeline().fork(branch, withSource)).toThrow(TypeError)

    expect(() => definePipeline().forkSync()).toThrow(TypeError)
    expect(() => definePipeline().forkSync(withSource)).toThrow(TypeError)
    expect(() =>
      definePipeline().forkSync({ id: 'invalid', steps: 'nope' } as unknown as Pipeline),
    ).toThrow(TypeError)
  })

  it('split-form .subflow() resolves the splitter and injects a void target when the child has none', () => {
    const splitter = { name: 'dsl-operators-splitter', split: () => ['a'] }
    registry.registerSplitter('dsl-operators-entities', splitter)
    const child = definePipeline({ id: 'split-child' }).tap(async () => {})

    const pipeline = definePipeline({ id: 'split-flow' })
      .from(source('jsonl://in.jsonl'))
      .subflow('dsl-operators-entities://', child)

    const splitStep = pipeline.steps.find((s) => s.type === 'split')
    expect(splitStep?.config.splitter).toBe(splitter)
    expect(splitStep?.config.pipeline).not.toBe(child)
    const steps = (splitStep?.config.pipeline as Pipeline).steps
    expect(steps[steps.length - 1]).toEqual({ type: 'target', config: { uri: 'void://' } })

    const childWithTarget = definePipeline({ id: 'split-child-2' }).to(target('jsonl://out.jsonl'))
    const pipeline2 = definePipeline({ id: 'split-flow-2' })
      .from(source('jsonl://in.jsonl'))
      .subflow('#dsl-operators-entities', childWithTarget)
    const split2 = pipeline2.steps.find((s) => s.type === 'split')
    expect(split2?.config.pipeline).toBe(childWithTarget)
  })

  it('rejects a split-form subflow child with its own source or a non-pipeline', () => {
    registry.registerSplitter('dsl-operators-entities', { name: 'x', split: () => ['a'] })
    const withSource = definePipeline({ id: 'with-source' }).from(source('jsonl://a.jsonl'))

    expect(() =>
      definePipeline({ id: 'bad-child' })
        .from(source('jsonl://in.jsonl'))
        .subflow('dsl-operators-entities://', withSource),
    ).toThrow(/must not declare its own source/)
    expect(() =>
      definePipeline({ id: 'bad-arg' })
        .from(source('jsonl://in.jsonl'))
        .subflow('dsl-operators-entities://', undefined as unknown as Pipeline<unknown, unknown>),
    ).toThrow(TypeError)
  })
})

describe('DSL Operators: batch subflow (batch://)', () => {
  const child = (id = 'batch-child') => definePipeline({ id }).tap(async () => {})
  const builder = (id = 'batch-parent') => definePipeline({ id }).from(source('jsonl://in.jsonl'))

  beforeAll(() => {
    // `@mt/core` never imports the batch views: a definition-time-injected `batch://return`
    // and a child-side `batch://group` source only need *a* registered endpoint here.
    registry.registerSource('batch', (uri: ParsedUri) => ({
      uri: uri.raw,
      lifestyle: 'resumable',
      async *start() {
        yield { item: {}, meta: {} }
      },
    }))
    registry.registerTarget('batch', (uri: ParsedUri) => ({
      uri: uri.raw,
      async open() {},
      async write() {},
      async close() {},
    }))
  })

  it('defaults to size 5, tumbling', () => {
    const pipeline = builder().subflow('batch://', child())
    const config = pipeline.steps[1]?.config as { size: number; slide: boolean }

    expect(config.size).toBe(DEFAULT_BATCH_SIZE)
    expect(config.slide).toBe(false)
    expect('batch' in pipeline).toBe(false)
  })

  it('parses size, the batchSize alias, the slide mode and the slide flag', () => {
    const config = (uri: `batch://${string}`) => {
      const step = builder().subflow(uri, child()).steps[1]
      return step?.config as { size?: number; slide?: boolean }
    }

    expect(parseBatchUri('batch://?size=3')).toEqual({ size: 3, slide: false })
    expect(parseBatchUri('batch://tumbling?size=3')).toEqual({ size: 3, slide: false })
    expect(parseBatchUri('batch://?batchSize=3')).toEqual({ size: 3, slide: false })
    expect(parseBatchUri('batch://slide?size=3')).toEqual({ size: 3, slide: true })
    expect(parseBatchUri('batch://?size=3&slide=true')).toEqual({ size: 3, slide: true })
    // an explicit ?slide= wins over the mode segment
    expect(parseBatchUri('batch://slide?slide=false')).toEqual({ size: 5, slide: false })
    expect(config('batch://slide?size=3')).toMatchObject({ size: 3, slide: true })
  })

  it('rejects bad sizes, modes, query keys and slide values at definition time', () => {
    expect(() => builder().subflow('batch://?size=0', child())).toThrow(
      /size must be a positive integer, got 0/,
    )
    expect(() => builder().subflow('batch://?size=-1', child())).toThrow(RangeError)
    expect(() => builder().subflow('batch://?size=1.5', child())).toThrow(RangeError)
    expect(() => builder().subflow('batch://?size=abc', child())).toThrow(RangeError)
    expect(() => builder().subflow('batch://?batchSize=0', child())).toThrow(RangeError)
    expect(() => builder().subflow('batch://fast?size=2', child())).toThrow(
      /unknown batch mode 'fast'/,
    )
    expect(() => builder().subflow('batch://?size=2&depth=3', child())).toThrow(
      /unknown query parameter 'depth'/,
    )
    expect(() => builder().subflow('batch://?slide=yes', child())).toThrow(TypeError)
  })

  it('injects batch://return when the child declares no target', () => {
    const pipeline = builder().subflow('batch://?size=2', child('injected'))
    const nested = (pipeline.steps[1]?.config as { pipeline: Pipeline }).pipeline

    expect(nested.id).toBe('injected')
    expect(nested.steps.at(-1)).toEqual({ type: 'target', config: { uri: 'batch://return' } })
  })

  it('keeps an explicit child target (sink form)', () => {
    const sink = child('sink').to(target('jsonl://out.jsonl'))
    const pipeline = builder().subflow('batch://?size=2', sink)
    const nested = (pipeline.steps[1]?.config as { pipeline: Pipeline }).pipeline

    expect(nested).toBe(sink)
    expect(nested.steps.filter((step) => step.type === 'target')).toHaveLength(1)
  })

  it('allows a child-side batch:// source but rejects any other child source', () => {
    const viewChild = definePipeline({ id: 'view-child' }).from(source('batch://group'))
    expect(() => builder().subflow('batch://?size=2', viewChild)).not.toThrow()

    const ownSource = definePipeline({ id: 'own-source' }).from(source('jsonl://a.jsonl'))
    expect(() => builder().subflow('batch://?size=2', ownSource)).toThrow(
      /must not declare its own source/,
    )
  })

  it('rejects a non-pipeline child and the child-side views in the subflow source', () => {
    expect(() =>
      builder().subflow('batch://?size=2', undefined as unknown as Pipeline<unknown, unknown>),
    ).toThrow(TypeError)
    for (const uri of ['batch://group', 'batch://members', 'batch://return'] as const) {
      expect(() => builder().subflow(uri, child())).toThrow(/child-side batch view/)
    }
  })
})
