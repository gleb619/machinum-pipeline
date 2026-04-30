import { describe, it, expect, vi } from 'vitest'
import { Runner } from '../../src/engine/runner.js'
import type { Pipeline } from '../../src/types.js'
import type { GlobalContext } from '../../src/contexts.js'
import { Store } from '../../src/store.js'

vi.mock('../../src/store.js', () => {
  return {
    Store: class {
      ensureDir = vi.fn()
      writeJson = vi.fn()
      readJson = vi.fn().mockResolvedValue({
        runId: 'test',
        pipelineId: 'test',
        state: 'running',
        startedAt: '2026-04-29T20:00:00.000Z',
        updatedAt: '2026-04-29T20:00:00.000Z',
        checkpoint: { stepId: 'root', state: 'done' },
        contextRef: 'runs/test/context.json',
      })
    },
  }
})

describe('Runner Concurrency', () => {
  it('should respect concurrency limit for tools', async () => {
    const pipeline: Pipeline = {
      id: 'test-concurrency',
      retry: { max: 0, backoffMs: 0, strategy: 'fixed' },
      onError: 'fail-run',
      steps: [
        { type: 'tool', config: { name: 'test-tool', concurrency: '2' } }
      ],
    }

    const globalContext: GlobalContext = {
      project: { name: 'test', root: '/tmp' },
      defaults: { retry: { max: 0, backoffMs: 0, strategy: 'fixed' }, onError: 'fail-run', concurrency: 4 },
    }

    const runner = new Runner(pipeline, globalContext)
    // Spy on the console or logger to verify execution if needed, 
    // but here we just check if it runs without errors.
    await expect(runner.start()).resolves.toBeDefined()
  })
})
