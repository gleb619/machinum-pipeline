import { describe, expect, it } from 'vitest'
import { PipelineBuilder, definePipeline, defineTool } from '../src/dsl.js'
describe('UC-02 — Author a pipeline in TS (architectural)', () => {
  it('definePipeline returns a PipelineBuilder', () => {
    const builder = definePipeline({
      id: 'test',
      retry: { max: 3, backoffMs: 1000, strategy: 'exp' },
      onError: 'fail-run',
    })
    expect(builder).toBeInstanceOf(PipelineBuilder)
  })
  it('PipelineBuilder exposes fluent methods: from, use, to, batch, fork, tap', () => {
    const builder = definePipeline({
      id: 'test',
      retry: { max: 3, backoffMs: 1000, strategy: 'exp' },
      onError: 'fail-run',
    })
    expect(typeof builder.from).toBe('function')
    expect(typeof builder.use).toBe('function')
    expect(typeof builder.to).toBe('function')
    expect(typeof builder.batch).toBe('function')
    expect(typeof builder.fork).toBe('function')
    expect(typeof builder.tap).toBe('function')
  })
  it('result from .to() satisfies Pipeline interface shape', () => {
    const pipeline = definePipeline({
      id: 'test-pipeline',
      retry: { max: 3, backoffMs: 1000, strategy: 'exp' },
      onError: 'fail-run',
    })
      .from({ uri: 'jsonl://./in.jsonl' })
      .to({ uri: 'jsonl://./out.jsonl' })
    const p = pipeline
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
      invoke: async (env) => env,
    })
    expect(typeof tool.name).toBe('string')
    expect(tool.name).toBe('uppercase')
    expect(typeof tool.version).toBe('string')
    expect(typeof tool.invoke).toBe('function')
    expect('exec' in tool).toBe(true) // defaults to 'inproc'
  })
  it('defineTool supports optional cacheable flag', () => {
    const tool = defineTool({
      name: 'cached-tool',
      version: '1.0.0',
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
      .from({ uri: 'jsonl://./in.jsonl' })
      .to({ uri: 'jsonl://./out.jsonl' })
    const p = pipeline
    expect(p.retry.max).toBe(5)
    expect(p.retry.strategy).toBe('linear')
    expect(p.onError).toBe('skip-item')
  })
  it('.use(tool, { retry }) injects per-tool retry override into step config', () => {
    const tool = defineTool({
      name: 't',
      version: '1.0.0',
      invoke: async (env) => env,
    })
    const pipeline = definePipeline({
      id: 'test',
      retry: { max: 3, backoffMs: 1000, strategy: 'exp' },
      onError: 'fail-run',
    })
      .from({ uri: 'jsonl://./in.jsonl' })
      .use(tool, {
        retry: { max: 1, strategy: 'fixed' },
        onError: 'skip-item',
      })
      .to({ uri: 'jsonl://./out.jsonl' })
    const p = pipeline
    const toolStep = p.steps.find((s) => s.type === 'tool')
    expect(toolStep).toBeDefined()
    expect(toolStep?.config.retry?.max).toBe(1)
    expect(toolStep?.config.retry?.strategy).toBe('fixed')
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
  it('.batch(size) pushes a step with type batch and config.size', () => {
    const pipeline = makePipeline()
      .from({ uri: 'jsonl://./in.jsonl' })
      .batch(5)
      .to({ uri: 'jsonl://./out.jsonl' })
    const p = pipeline
    const batchStep = p.steps.find((s) => s.type === 'batch')
    expect(batchStep).toBeDefined()
    expect(batchStep?.config.size).toBe(5)
  })
  it('.window(size) pushes a step with type window and config.size', () => {
    const pipeline = makePipeline()
      .from({ uri: 'jsonl://./in.jsonl' })
      .window(3)
      .to({ uri: 'jsonl://./out.jsonl' })
    const p = pipeline
    const windowStep = p.steps.find((s) => s.type === 'window')
    expect(windowStep).toBeDefined()
    expect(windowStep?.config.size).toBe(3)
  })
  it('.fork(subPipeline) pushes a step with type fork and config.pipeline', () => {
    const subPipeline = makePipeline()
      .from({ uri: 'jsonl://./sub-in.jsonl' })
      .to({ uri: 'jsonl://./sub-out.jsonl' })
    const pipeline = makePipeline()
      .from({ uri: 'jsonl://./in.jsonl' })
      .fork(subPipeline)
      .to({ uri: 'jsonl://./out.jsonl' })
    const p = pipeline
    const forkStep = p.steps.find((s) => s.type === 'fork')
    expect(forkStep).toBeDefined()
    expect(forkStep?.config.pipeline).toBe(subPipeline)
  })
  it('.flatMap(fn) pushes a step with type flatmap and config.fn', () => {
    const fn = async (item) => [item]
    const pipeline = makePipeline()
      .from({ uri: 'jsonl://./in.jsonl' })
      .flatMap(fn)
      .to({ uri: 'jsonl://./out.jsonl' })
    const p = pipeline
    const flatmapStep = p.steps.find((s) => s.type === 'flatmap')
    expect(flatmapStep).toBeDefined()
    expect(typeof flatmapStep?.config.fn).toBe('function')
  })
  it('.tap(fn) pushes a step with type tap and config.fn', () => {
    const fn = async (_item) => {}
    const pipeline = makePipeline()
      .from({ uri: 'jsonl://./in.jsonl' })
      .tap(fn)
      .to({ uri: 'jsonl://./out.jsonl' })
    const p = pipeline
    const tapStep = p.steps.find((s) => s.type === 'tap')
    expect(tapStep).toBeDefined()
    expect(typeof tapStep?.config.fn).toBe('function')
  })
  it('PipelineStep.type union includes batch, window, fork, flatmap, tap', () => {
    const pipeline = makePipeline()
      .from({ uri: 'jsonl://./in.jsonl' })
      .batch(5)
      .window(3)
      .flatMap(async (item) => [item])
      .tap(async () => {})
      .to({ uri: 'jsonl://./out.jsonl' })
    const p = pipeline
    const types = p.steps.map((s) => s.type)
    expect(types).toContain('source')
    expect(types).toContain('batch')
    expect(types).toContain('window')
    expect(types).toContain('flatmap')
    expect(types).toContain('tap')
    expect(types).toContain('target')
  })
})
//# sourceMappingURL=dsl.arch.test.js.map
