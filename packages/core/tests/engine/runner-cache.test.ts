import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Runner } from '../../src/engine/runner.js'
import type { Pipeline, Tool } from '../../src/types.js'
import type { GlobalContext } from '../../src/contexts.js'
import { mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

describe('runner caching', () => {
  let tempDir: string

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'mt-runner-test-'))
  })

  it('should use cached tool output', async () => {
    const mockTool: Tool<unknown, unknown> = {
      name: 'testTool',
      version: '1.0.0',
      cacheable: true,
      invoke: vi.fn().mockImplementation(async () => {
        return { item: 'result' }
      }),
    }

    const pipeline: Pipeline = {
      id: 'p1',
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
      defaults: { retry: { max: 0, backoffMs: 0, strategy: 'fixed' }, onError: 'fail-run', concurrency: 1 },
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
})
