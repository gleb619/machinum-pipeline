import { describe, expect, it, vi } from 'vitest'
import type { GlobalContext } from '../../src/contexts.js'
import { Runner } from '../../src/engine/runner.js'
import { Store } from '../../src/store.js'
import type { Pipeline } from '../../src/types.js'

vi.mock('../../src/store.js', () => ({
  Store: class {
    ensureDir = vi.fn().mockResolvedValue(undefined)
    writeJson = vi.fn().mockResolvedValue(undefined)
    readJson = vi.fn().mockResolvedValue({ state: 'done', checkpoint: { stepId: 'root' } })
  },
}))

describe('runner', () => {
  it('should initialize and start', async () => {
    const pipeline: Pipeline = {
      id: 'p1',
      retry: { max: 0, backoffMs: 0, strategy: 'fixed' },
      onError: 'fail-run',
      steps: [],
    }
    const globalContext: GlobalContext = {
      project: { name: 'test', root: '/tmp' },
      defaults: {
        retry: { max: 0, backoffMs: 0, strategy: 'fixed' },
        onError: 'fail-run',
        concurrency: 1,
      },
      env: {},
    }

    const runner = new Runner(pipeline, globalContext)
    const ctx = await runner.start()
    expect(ctx.pipelineId).toBe('p1')
    expect(runner.getRunId()).toBeDefined()
  })
})
