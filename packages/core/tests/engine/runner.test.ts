import { describe, it, expect, vi } from 'vitest'
import { Runner } from '../../src/engine/runner.js'
import { Store } from '../../src/store.js'
import type { Pipeline, GlobalContext } from '../../src/types.js'

vi.mock('../../src/store.js', () => ({
  Store: class {
    ensureDir = vi.fn().mockResolvedValue(undefined)
    writeJson = vi.fn().mockResolvedValue(undefined)
    readJson = vi.fn().mockResolvedValue({ state: 'done', checkpoint: { stepId: 'root' } })
  },
}))

describe('runner', () => {
  it('should initialize and start', async () => {
    const pipeline: Pipeline = { id: 'p1', steps: [] }
    const globalContext: GlobalContext = {
      project: { root: '/tmp' },
      engine: { retry: 0, backoff: 0, concurrency: 1 },
      paths: { cache: '/tmp/.mt/cache', runs: '/tmp/.mt/runs' }
    }
    
    const runner = new Runner(pipeline, globalContext)
    const ctx = await runner.start()
    expect(ctx.pipelineId).toBe('p1')
    expect(runner.getRunId()).toBeDefined()
  })
})
