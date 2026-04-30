import { describe, it, expect } from 'vitest'
import { definePipeline, defineTool, source, target, PipelineBuilder } from '../src/dsl.js'
import type { Envelope, Book, Chapter, Paragraph, Line } from '../src/index.js'
// Ensure builtins are registered for tests
import '../src/builtins/jsonl-source.js'

describe('DSL', () => {
  it('T002-02: definePipeline returns a PipelineBuilder', () => {
    const builder = definePipeline({
      id: 'test',
      retry: { max: 3, backoffMs: 1000, strategy: 'exp' },
      onError: 'fail-run',
    })
    expect(builder).toBeInstanceOf(PipelineBuilder)
  })

  it('T002-03: builder produces a pipeline via .to()', () => {
    // Register jsonl source/target for tests
    const testUri = 'jsonl://./test.jsonl'

    const pipeline = definePipeline({
      id: 'test-pipeline',
      retry: { max: 3, backoffMs: 1000, strategy: 'exp' },
      onError: 'fail-run',
    })
      .from(source(testUri))
      .to(target(testUri))

    expect(pipeline.id).toBe('test-pipeline')
    expect(pipeline.retry.max).toBe(3)
    expect(pipeline.steps.length).toBe(2)
    expect(pipeline.steps[0]?.type).toBe('source')
    expect(pipeline.steps[1]?.type).toBe('target')
  })

  it('T002-04: supports .use() and .batch()', () => {
    const tool = defineTool({
      name: 'uppercase',
      version: '1.0.0',
      invoke: async (env) => env,
    })

    const pipeline = definePipeline({
      id: 'with-tool',
      retry: { max: 3, backoffMs: 1000, strategy: 'exp' },
      onError: 'fail-run',
    })
      .from(source('jsonl://./input.jsonl'))
      .use(tool)
      .batch(5)
      .to(target('jsonl://./output.jsonl'))

    expect(pipeline.steps.length).toBe(4)
    expect(pipeline.steps[0]?.type).toBe('source')
    expect(pipeline.steps[1]?.type).toBe('tool')
    expect(pipeline.steps[2]?.type).toBe('batch')
    expect(pipeline.steps[3]?.type).toBe('target')
  })

  it('T002-06: defineTool creates a Tool with default exec', () => {
    const tool = defineTool({
      name: 'test-tool',
      version: '1.0.0',
      invoke: async (env) => env,
    })

    expect(tool.name).toBe('test-tool')
    expect(tool.exec).toBe('inproc')
    expect(tool.cacheable).toBeUndefined()
  })

  it('T002-08: defineTool supports exec configuration', () => {
    const tool = defineTool({
      name: 'remote-tool',
      version: '2.0.0',
      invoke: async (env) => env,
      exec: 'npx',
      cacheable: true,
    })

    expect(tool.name).toBe('remote-tool')
    expect(tool.exec).toBe('npx')
    expect(tool.cacheable).toBe(true)
  })

  it('T002-01: .window() operator adds correct step', () => {
    const pipeline = definePipeline({
      id: 'window-test',
      retry: { max: 3, backoffMs: 1000, strategy: 'exp' },
      onError: 'fail-run',
    })
      .from(source('jsonl://./input.jsonl'))
      .window(10)
      .to(target('jsonl://./output.jsonl'))

    expect(pipeline.steps.length).toBe(3)
    expect(pipeline.steps[1]?.type).toBe('window')
    expect(pipeline.steps[1]?.config.size).toBe(10)
  })

  it('T002-05: tool retry overrides are stored correctly', () => {
    const tool = defineTool({
      name: 'retry-tool',
      version: '1.0.0',
      invoke: async (env) => env,
    })

    const pipeline = definePipeline({
      id: 'retry-override-test',
      retry: { max: 3, backoffMs: 1000, strategy: 'exp' },
      onError: 'fail-run',
    })
      .from(source('jsonl://./input.jsonl'))
      .use(tool, { retry: { max: 10, backoffMs: 2000, strategy: 'fixed' } })
      .to(target('jsonl://./output.jsonl'))

    const config = pipeline.steps[1]?.config as any
    expect(config.retry.max).toBe(10)
    expect(config.retry.backoffMs).toBe(2000)
    expect(config.retry.strategy).toBe('fixed')
  })

  it('T002-07: pipeline builds with all operator types', () => {
    const tool = defineTool({
      name: 'test-tool',
      version: '1.0.0',
      invoke: async (env) => env,
    })

    const pipeline = definePipeline({
      id: 'full-chain-test',
      retry: { max: 3, backoffMs: 1000, strategy: 'exp' },
      onError: 'fail-run',
    })
      .from(source('jsonl://./input.jsonl'))
      .use(tool)
      .batch(5)
      .window(3)
      .to(target('jsonl://./output.jsonl'))

    expect(pipeline.steps.length).toBe(5)
    expect(pipeline.steps.map(s => s.type)).toEqual([
      'source',
      'tool',
      'batch',
      'window',
      'target'
    ])
  })

  it('T002-09: defineSource and defineTarget resolve correctly', () => {
    const testUri = 'jsonl://./test.jsonl'
    
    const src = source(testUri)
    const tgt = target(testUri)

    expect(src.uri).toBe(testUri)
    expect(tgt.uri).toBe(testUri)
  })

  it('T002-10: defineTool correctly sets idempotent flag', () => {
    const tool = defineTool({
      name: 'idempotent-tool',
      version: '1.0.0',
      invoke: async (env) => env,
      idempotent: true,
    })

    expect(tool.idempotent).toBe(true)
  })

  it('T002-11: domain models are correctly defined (type check)', () => {
    const book: Book = {
      id: 'book-1',
      name: 'Test Book',
      author: 'Test Author',
    }
    const chapter: Chapter = {
      id: 'chap-1',
      bookId: 'book-1',
      title: 'Chapter 1',
      body: 'Content',
    }
    const paragraph: Paragraph = {
      id: 'para-1',
      chapterId: 'chap-1',
      body: 'Paragraph content',
    }
    const line: Line = {
      id: 'line-1',
      paragraphId: 'para-1',
      text: 'Line text',
    }

    expect(book.id).toBe('book-1')
    expect(chapter.title).toBe('Chapter 1')
    expect(paragraph.body).toBe('Paragraph content')
    expect(line.text).toBe('Line text')
  })

  it('T002-12: Envelope structure is correct', () => {
    const envelope: Envelope<string> = {
      item: 'test-item',
      meta: {
        chapterId: 'chap-1',
      },
    }
    expect(envelope.item).toBe('test-item')
    expect(envelope.meta.chapterId).toBe('chap-1')
  })
})
