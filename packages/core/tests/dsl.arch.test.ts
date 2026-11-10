import { describe, expect, it, vi } from 'vitest'
import { PipelineBuilder, definePipeline, defineTool } from '../src/dsl.js'
import type { Pipeline, RetryPolicy, Tool } from '../src/types.js'
import { registry } from '../src/uri.js'

describe('UC-02 — Author a pipeline in TS (architectural)', () => {
  it('definePipeline returns a PipelineBuilder', () => {
    const builder = definePipeline({
      id: 'test',
      retry: { max: 3, backoffMs: 1000, strategy: 'exp' },
      onError: 'fail-run',
    })
    expect(builder).toBeInstanceOf(PipelineBuilder)
  })

  it('PipelineBuilder exposes fluent methods: from, use, to, subflow, fork, tap', () => {
    const builder = definePipeline({
      id: 'test',
      retry: { max: 3, backoffMs: 1000, strategy: 'exp' },
      onError: 'fail-run',
    })
    expect(typeof builder.from).toBe('function')
    expect(typeof builder.use).toBe('function')
    expect(typeof builder.to).toBe('function')
    expect(typeof builder.subflow).toBe('function')
    expect(typeof builder.fork).toBe('function')
    expect(typeof builder.tap).toBe('function')
    // no `.batch()` op: grouping is the batch form of `.subflow()`
    expect('batch' in builder).toBe(false)
  })

  it('result from .to() satisfies Pipeline interface shape', () => {
    const pipeline = definePipeline({
      id: 'test-pipeline',
      retry: { max: 3, backoffMs: 1000, strategy: 'exp' },
      onError: 'fail-run',
    })
      .from({ uri: 'jsonl://./in.jsonl' } as never)
      .to({ uri: 'jsonl://./out.jsonl' } as never)

    const p = pipeline as Pipeline
    expect(typeof p.id).toBe('string')
    expect(p.retry).toBeDefined()
    expect(typeof p.retry.max).toBe('number')
    expect(p.onError).toBeDefined()
    expect(Array.isArray(p.steps)).toBe(true)
  })
})

describe('UC-03 — Define a custom Tool (architectural)', () => {
  it('defineTool returns an object satisfying Tool shape', () => {
    const tool = defineTool({
      name: 'uppercase',
      version: '1.0.0',
      mdDescription: 'Test tool that converts text to uppercase.',
      invoke: async (env) => env,
    })

    expect(typeof tool.name).toBe('string')
    expect(tool.name).toBe('uppercase')
    expect(typeof tool.version).toBe('string')
    expect(typeof tool.invoke).toBe('function')
  })

  it('defineTool supports optional cacheable flag', () => {
    const tool = defineTool({
      name: 'cached-tool',
      version: '1.0.0',
      mdDescription: 'Test tool for cacheable flag tests.',
      cacheable: true,
      invoke: async (env) => env,
    })

    expect(tool.cacheable).toBe(true)
  })
})

describe('UC-47 — Configure retry/onError policies (architectural)', () => {
  it('Pipeline shape contains retry and onError at top level', () => {
    const pipeline = definePipeline({
      id: 'test',
      retry: { max: 5, backoffMs: 500, strategy: 'linear' },
      onError: 'skip-item',
    })
      .from({ uri: 'jsonl://./in.jsonl' } as never)
      .to({ uri: 'jsonl://./out.jsonl' } as never)

    const p = pipeline as Pipeline
    expect(p.retry.max).toBe(5)
    expect(p.retry.strategy).toBe('linear')
    expect(p.onError).toBe('skip-item')
  })

  it('.use(tool, { retry }) injects per-tool retry override into step config', () => {
    const tool = defineTool({
      name: 't',
      version: '1.0.0',
      mdDescription: 'Test tool for retry override tests.',
      invoke: async (env) => env,
    })

    const pipeline = definePipeline({
      id: 'test',
      retry: { max: 3, backoffMs: 1000, strategy: 'exp' },
      onError: 'fail-run',
    })
      .from({ uri: 'jsonl://./in.jsonl' } as never)
      .use(tool as Tool<unknown, unknown>, {
        retry: { max: 1, strategy: 'fixed' },
        onError: 'skip-item',
      })
      .to({ uri: 'jsonl://./out.jsonl' } as never)

    const p = pipeline as Pipeline
    const toolStep = p.steps.find((s) => s.type === 'tool')
    expect(toolStep).toBeDefined()
    expect((toolStep?.config.retry as RetryPolicy | undefined)?.max).toBe(1)
    expect((toolStep?.config.retry as RetryPolicy | undefined)?.strategy).toBe('fixed')
    expect(toolStep?.config.onError).toBe('skip-item')
  })
})

describe('UC-12/UC-13/UC-14 — Batch, Window, Fork & FlatMap DSL (architectural)', () => {
  const makePipeline = () =>
    definePipeline({
      id: 'test',
      retry: { max: 3, backoffMs: 1000, strategy: 'exp' },
      onError: 'fail-run',
    })

  it(".subflow('batch://?size=5', pipe) pushes a batch step with its child", () => {
    const child = makePipeline().tap(async () => {})
    const pipeline = makePipeline()
      .from({ uri: 'jsonl://./in.jsonl' } as never)
      .subflow('batch://?size=5', child)
      .to({ uri: 'jsonl://./out.jsonl' } as never)

    const p = pipeline as Pipeline
    const batchStep = p.steps.find((s) => s.type === 'batch')
    expect(batchStep).toBeDefined()
    expect(batchStep?.config).toMatchObject({ size: 5, slide: false })
    expect((batchStep?.config.pipeline as Pipeline | undefined)?.id).toBe(child.id)
    // the child had no target: `batch://return` is injected so the package comes back patched
    expect((batchStep?.config.pipeline as Pipeline | undefined)?.steps.at(-1)).toEqual({
      type: 'target',
      config: { uri: 'batch://return' },
    })
  })

  it(".subflow('batch://slide?size=3', pipe) pushes config.slide", () => {
    const pipeline = makePipeline()
      .from({ uri: 'jsonl://./in.jsonl' } as never)
      .subflow(
        'batch://slide?size=3',
        makePipeline().tap(async () => {}),
      )
      .to({ uri: 'jsonl://./out.jsonl' } as never)

    const p = pipeline as Pipeline
    const batchStep = p.steps.find((s) => s.type === 'batch')
    expect(batchStep?.config.size).toBe(3)
    expect(batchStep?.config.slide).toBe(true)
  })

  it('.fork(subPipeline) pushes a parallel fork step with config.pipelines', () => {
    // branches receive envelopes from the parent stream: no own `.from()`
    const subPipeline = makePipeline()
      .tap(async () => {})
      .to({ uri: 'jsonl://./sub-out.jsonl' } as never)

    const pipeline = makePipeline()
      .from({ uri: 'jsonl://./in.jsonl' } as never)
      .fork(subPipeline)
      .to({ uri: 'jsonl://./out.jsonl' } as never)

    const p = pipeline as Pipeline
    const forkStep = p.steps.find((s) => s.type === 'fork')
    expect(forkStep).toBeDefined()
    expect(forkStep?.config.pipelines).toEqual([subPipeline])
  })

  it('.flatMap(fn) pushes a step with type flatmap and config.fn', () => {
    const fn = async (item: unknown) => [item]
    const pipeline = makePipeline()
      .from({ uri: 'jsonl://./in.jsonl' } as never)
      .flatMap(fn)
      .to({ uri: 'jsonl://./out.jsonl' } as never)

    const p = pipeline as Pipeline
    const flatmapStep = p.steps.find((s) => s.type === 'flatmap')
    expect(flatmapStep).toBeDefined()
    expect(typeof flatmapStep?.config.fn).toBe('function')
  })

  it('.subflow(source, pipeline) resolves a registered splitter into the internal split step', () => {
    const splitter = {
      name: 'test-splitter',
      split: async () => ['a', 'b'],
    }
    registry.registerSplitter('test-entities', splitter)
    const child = makePipeline().tap(async () => {})
    const pipeline = makePipeline()
      .from({ uri: 'jsonl://./in.jsonl' } as never)
      .subflow('test-entities://', child)
      .to({ uri: 'jsonl://./out.jsonl' } as never)

    const p = pipeline as Pipeline
    const splitStep = p.steps.find((s) => s.type === 'split')
    expect(splitStep).toBeDefined()
    expect(splitStep?.config.splitter).toBe(splitter)
    expect(splitStep?.config.splitterType).toBe('test-entities://')
    expect(splitStep?.config.pipeline).not.toBe(child)
  })

  it('.subflow(uri) reads the splitter type from the URI scheme', () => {
    const splitter = {
      name: 'test-splitter-uri',
      split: async () => ['a'],
    }
    registry.registerSplitter('test-uri-entities', splitter)
    const child = makePipeline().tap(async () => {})
    const pipeline = makePipeline()
      .from({ uri: 'jsonl://./in.jsonl' } as never)
      .subflow('test-uri-entities://ladder', child)
      .to({ uri: 'jsonl://./out.jsonl' } as never)

    const p = pipeline as Pipeline
    const splitStep = p.steps.find((s) => s.type === 'split')
    expect(splitStep?.config.splitter).toBe(splitter)
    expect(splitStep?.config.splitterType).toBe('test-uri-entities://ladder')
  })

  it('.subflow(#splitterType, pipeline) resolves the shortcut form', () => {
    const splitter = {
      name: 'test-splitter-shortcut',
      split: async () => ['a'],
    }
    registry.registerSplitter('test-shortcut-entities', splitter)
    const child = makePipeline().tap(async () => {})
    const pipeline = makePipeline()
      .from({ uri: 'jsonl://./in.jsonl' } as never)
      .subflow('#test-shortcut-entities', child)
      .to({ uri: 'jsonl://./out.jsonl' } as never)

    const p = pipeline as Pipeline
    const splitStep = p.steps.find((s) => s.type === 'split')
    expect(splitStep?.config.splitter).toBe(splitter)
    expect(splitStep?.config.splitterType).toBe('#test-shortcut-entities')
  })

  it('.subflow(bareScheme) rejects the old simple spelling', () => {
    // The split form requires a child pipeline, so the bare spelling is only reachable through a
    // widened call — it must still fail at run time.
    const widened = makePipeline().from({ uri: 'jsonl://./in.jsonl' } as never) as unknown as {
      subflow(uri: string): unknown
    }
    expect(() => widened.subflow('test-bare-entities')).toThrow(/must be a buffer URI/)
  })

  it('.subflow(unknownType) throws with the known splitter schemes', () => {
    const child = makePipeline().tap(async () => {})
    expect(() =>
      makePipeline()
        .from({ uri: 'jsonl://./in.jsonl' } as never)
        .subflow('missing-entities://', child),
    ).toThrow(/No splitter registered for scheme: missing-entities.*Known splitter schemes:/)
  })

  it('.subflow(source, pipeline) rejects a child with its own source step', () => {
    registry.registerSplitter('test-reject-source', { name: 'rs', split: () => ['a'] })
    const withSource = makePipeline().from({ uri: 'jsonl://./other.jsonl' } as never)
    expect(() =>
      makePipeline()
        .from({ uri: 'jsonl://./in.jsonl' } as never)
        .subflow('test-reject-source://', withSource),
    ).toThrow(TypeError)
  })

  it('.tap(fn) pushes a step with type tap and config.fn', () => {
    const fn = async (_item: unknown) => {}
    const pipeline = makePipeline()
      .from({ uri: 'jsonl://./in.jsonl' } as never)
      .tap(fn)
      .to({ uri: 'jsonl://./out.jsonl' } as never)

    const p = pipeline as Pipeline
    const tapStep = p.steps.find((s) => s.type === 'tap')
    expect(tapStep).toBeDefined()
    expect(typeof tapStep?.config.fn).toBe('function')
  })

  it('.tap(fn) accepts a synchronous callback (void, no async)', () => {
    const seen: unknown[] = []
    const pipeline = makePipeline()
      .from({ uri: 'jsonl://./in.jsonl' } as never)
      .tap((ex) => {
        seen.push(ex.item)
      })
      .to({ uri: 'jsonl://./out.jsonl' } as never)

    const p = pipeline as Pipeline
    const tapStep = p.steps.find((s) => s.type === 'tap')
    expect(typeof tapStep?.config.fn).toBe('function')
    expect(seen).toHaveLength(0)
  })

  it('.log() wraps tap and emits one formatted line with label, exchange id and item', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {})
    try {
      const pipeline = makePipeline()
        .from({ uri: 'jsonl://./in.jsonl' } as never)
        .log({ label: 'debug', level: 'info' })
        .to({ uri: 'jsonl://./out.jsonl' } as never)

      const p = pipeline as Pipeline
      const tapStep = p.steps.find((s) => s.type === 'tap')
      expect(typeof tapStep?.config.fn).toBe('function')
      const log = tapStep?.config.fn as (ex: unknown) => void
      log({ id: 'ex-1', item: 'hello', meta: {}, variables: [] })
      expect(spy).toHaveBeenCalledTimes(1)
      expect(spy.mock.calls[0]?.length).toBe(1)
      expect(spy.mock.calls[0]?.[0]).toMatch(
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z \[INFO\] \[debug\] ex-1 hello$/,
      )
    } finally {
      spy.mockRestore()
    }
  })

  it('.log() escapes newlines inside a string item', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {})
    try {
      const pipeline = makePipeline()
        .from({ uri: 'jsonl://./in.jsonl' } as never)
        .log({ label: 'debug', level: 'info' })
        .to({ uri: 'jsonl://./out.jsonl' } as never)

      const p = pipeline as Pipeline
      const tapStep = p.steps.find((s) => s.type === 'tap')
      const log = tapStep?.config.fn as (ex: unknown) => void
      log({ id: 'ex-multi', item: 'line1\nline2', meta: {}, variables: [] })
      expect(spy).toHaveBeenCalledTimes(1)
      const line = spy.mock.calls[0]?.[0] as string
      expect(line).not.toContain('\n')
      expect(line).toContain('line1\\nline2')
    } finally {
      spy.mockRestore()
    }
  })

  it('.log({ level: "warn" }) emits a WARN line via console.warn', () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const pipeline = makePipeline()
        .from({ uri: 'jsonl://./in.jsonl' } as never)
        .log({ label: 'careful', level: 'warn' })
        .to({ uri: 'jsonl://./out.jsonl' } as never)

      const p = pipeline as Pipeline
      const tapStep = p.steps.find((s) => s.type === 'tap')
      const log = tapStep?.config.fn as (ex: unknown) => void
      log({ id: 'ex-3', item: 'watch out', meta: {}, variables: [] })
      expect(spy).toHaveBeenCalledTimes(1)
      expect(spy.mock.calls[0]?.length).toBe(1)
      expect(spy.mock.calls[0]?.[0]).toMatch(
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z \[WARN\] \[careful\] ex-3 watch out$/,
      )
    } finally {
      spy.mockRestore()
    }
  })

  it('.log() renders object items as compact JSON on a single line', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {})
    try {
      const pipeline = makePipeline()
        .from({ uri: 'jsonl://./in.jsonl' } as never)
        .log('stage')
        .to({ uri: 'jsonl://./out.jsonl' } as never)

      const p = pipeline as Pipeline
      const tapStep = p.steps.find((s) => s.type === 'tap')
      const log = tapStep?.config.fn as (ex: unknown) => void
      log({ id: 'ex-obj', item: { a: 1, b: [2, 3] }, meta: {}, variables: [] })
      expect(spy).toHaveBeenCalledTimes(1)
      expect(spy.mock.calls[0]?.length).toBe(1)
      expect(spy.mock.calls[0]?.[0]).toContain(' {"a":1,"b":[2,3]}')
    } finally {
      spy.mockRestore()
    }
  })

  it('.log(string) uses the argument as label and logs INFO by default', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {})
    try {
      const pipeline = makePipeline()
        .from({ uri: 'jsonl://./in.jsonl' } as never)
        .log('stage')
        .to({ uri: 'jsonl://./out.jsonl' } as never)

      const p = pipeline as Pipeline
      const tapStep = p.steps.find((s) => s.type === 'tap')
      const log = tapStep?.config.fn as (ex: unknown) => void
      log({ id: 'ex-2', item: 42, meta: {}, variables: [] })
      expect(spy).toHaveBeenCalledTimes(1)
      expect(spy.mock.calls[0]?.length).toBe(1)
      expect(spy.mock.calls[0]?.[0]).toMatch(
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z \[INFO\] \[stage\] ex-2 42$/,
      )
    } finally {
      spy.mockRestore()
    }
  })

  it('PipelineStep.type union includes batch, fork, flatmap, split, tap', () => {
    const splitter = { name: 'test-splitter', split: async () => ['a'] }
    registry.registerSplitter('test-union-entities', splitter)
    const pipeline = makePipeline()
      .from({ uri: 'jsonl://./in.jsonl' } as never)
      .subflow(
        'batch://?size=5',
        makePipeline().tap(async () => {}),
      )
      .flatMap(async (item) => [item])
      .subflow(
        'test-union-entities://',
        makePipeline().tap(async () => {}),
      )
      .tap(async () => {})
      .to({ uri: 'jsonl://./out.jsonl' } as never)

    const p = pipeline as Pipeline
    const types = p.steps.map((s) => s.type)
    expect(types).toContain('source')
    expect(types).toContain('batch')
    expect(types).toContain('flatmap')
    expect(types).toContain('split')
    expect(types).toContain('tap')
    expect(types).toContain('target')
  })
})
