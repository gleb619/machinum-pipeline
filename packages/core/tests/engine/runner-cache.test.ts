import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { GlobalContext } from '../../src/contexts.js'
import { Runner } from '../../src/engine/runner.js'
import type { Envelope, Pipeline, Tool } from '../../src/types.js'
import { registry } from '../../src/uri.js'

const cacheSourceItems: Array<Envelope<unknown>> = []
const cacheTargetItems: Array<Envelope<unknown>> = []

registry.registerSource('runner-cache-source', (_uri) => ({
  uri: _uri.raw,
  lifestyle: 'resumable' as const,
  async *start() {
    for (const env of cacheSourceItems) yield env
  },
  async *resume() {
    for (const env of cacheSourceItems) yield env
  },
}))

registry.registerTarget('runner-cache-target', (_uri) => ({
  uri: _uri.raw,
  async open() {},
  async write(env: Envelope<unknown>) {
    cacheTargetItems.push(env)
  },
  async close() {},
}))

function cacheTestPipeline(tool: Tool<unknown, unknown>): Pipeline {
  return {
    id: 'p-cache-test',
    retry: { max: 0, backoffMs: 0, strategy: 'fixed' },
    onError: 'fail-run',
    steps: [
      { type: 'source', config: { uri: 'runner-cache-source://in' } },
      { type: 'tool', config: { name: tool.name, tool } },
      { type: 'target', config: { uri: 'runner-cache-target://out' } },
    ],
  }
}

function makeGlobalContext(root: string): GlobalContext {
  return {
    project: { name: 'test', root },
    defaults: {
      retry: { max: 0, backoffMs: 0, strategy: 'fixed' },
      onError: 'fail-run',
      concurrency: 1,
    },
    settings: {},
    env: {},
  }
}

function cacheableTool(output: Envelope<unknown>): Tool<unknown, unknown> {
  return {
    name: 'cacheableTool',
    version: '1.0.0',
    mdDescription: 'Cacheable tool for best-effort cache tests.',
    cacheable: true,
    invoke: vi.fn().mockResolvedValue(output),
  }
}

describe('runner caching', () => {
  let tempDir: string
  let warnSpy: ReturnType<typeof vi.spyOn>

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'mt-runner-test-'))
    cacheSourceItems.length = 0
    cacheTargetItems.length = 0
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  it('should use cached tool output', async () => {
    const mockTool: Tool<unknown, unknown> = {
      name: 'testTool',
      version: '1.0.0',
      mdDescription: 'Test tool for caching tests.',
      cacheable: true,
      invoke: vi.fn().mockImplementation(async () => {
        return { item: 'result' }
      }),
    }

    const pipeline: Pipeline = {
      id: 'p1',
      retry: { max: 0, backoffMs: 0, strategy: 'fixed' },
      onError: 'fail-run',
      steps: [
        {
          type: 'tool',
          config: {
            name: 'testTool',
            tool: mockTool,
            input: { item: 'input' },
          },
        },
      ],
    }

    const globalContext: GlobalContext = {
      project: { name: 'test', root: tempDir },
      defaults: {
        retry: { max: 0, backoffMs: 0, strategy: 'fixed' },
        onError: 'fail-run',
        concurrency: 1,
      },
      settings: {},
      env: {},
    }

    const runner1 = new Runner(pipeline, globalContext)

    // First run - should call invoke
    await runner1.start()
    expect(mockTool.invoke).toHaveBeenCalledTimes(1)

    // Second run with a fresh runner instance
    const runner2 = new Runner(pipeline, globalContext)
    await runner2.start()

    // In second run, tool.invoke should NOT be called again
    expect(mockTool.invoke).toHaveBeenCalledTimes(1)
  })

  it('should return tool output when the cache write fails (BigInt output) under fail-run', async () => {
    const output: Envelope<unknown> = { item: { n: BigInt(42) }, meta: {} }
    const tool = cacheableTool(output)
    cacheSourceItems.push({ item: 'input', meta: {} })

    const runner = new Runner(cacheTestPipeline(tool), makeGlobalContext(tempDir))
    await expect(runner.start()).resolves.toBeDefined()

    expect(tool.invoke).toHaveBeenCalledTimes(1)
    expect(cacheTargetItems).toEqual([output])
    expect(
      warnSpy.mock.calls.some(
        ([msg]) => typeof msg === 'string' && msg.toLowerCase().includes('cache'),
      ),
    ).toBe(true)
  })

  it('should treat a circular-meta input as a cache miss instead of throwing', async () => {
    const circular: Record<string, unknown> = {}
    circular.self = circular
    const tool = cacheableTool({ item: 'done', meta: {} })
    cacheSourceItems.push({ item: 'input', meta: circular })

    const runner = new Runner(cacheTestPipeline(tool), makeGlobalContext(tempDir))
    await expect(runner.start()).resolves.toBeDefined()

    expect(tool.invoke).toHaveBeenCalledTimes(1)
    expect(cacheTargetItems).toEqual([{ item: 'done', meta: {} }])
    expect(
      warnSpy.mock.calls.some(
        ([msg]) => typeof msg === 'string' && msg.toLowerCase().includes('cache'),
      ),
    ).toBe(true)
  })
})
