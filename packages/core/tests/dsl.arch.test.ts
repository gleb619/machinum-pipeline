import { describe, expect, it } from 'vitest'
import { PipelineBuilder, definePipeline, defineTool } from '../src/dsl.js'
import type { Pipeline, Tool } from '../src/index.js'

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
    expect(toolStep?.config.retry?.max).toBe(1)
    expect(toolStep?.config.retry?.strategy).toBe('fixed')
    expect(toolStep?.config.onError).toBe('skip-item')
  })
})
