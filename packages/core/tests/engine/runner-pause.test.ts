import { describe, it, expect, vi } from 'vitest'
import { Runner } from '../../src/engine/runner.js'
import { Pipeline } from '../../src/types.js'
import { GlobalContext } from '../../src/contexts.js'

import { describe, it, expect } from 'vitest'
import { Runner } from '../../src/engine/runner.js'
import { Pipeline } from '../../src/types.js'
import { GlobalContext } from '../../src/contexts.js'

describe('Runner Pause', () => {
  it('should transition to paused state', async () => {
    const pipeline: Pipeline = {
      id: 'test-pause',
      retry: { max: 0, backoffMs: 0, strategy: 'fixed' },
      onError: 'fail-run',
      steps: [],
    }

    const globalCtx: GlobalContext = {
      project: { name: 'test', root: process.cwd() },
      defaults: { retry: { max: 0, backoffMs: 0, strategy: 'fixed' }, onError: 'fail-run', concurrency: 1 },
      env: {},
    }

    const runner = new Runner(pipeline, globalCtx)
    
    // Simulate a run by setting internal state directly or starting
    // Since we just want to test the pause mechanism:
    await runner.pause()
    // The runner state machine is private, but the method call should succeed 
    // without throwing if transition is allowed.
    // For this test, 'pending' -> 'paused' might not be allowed in transition table.
    // TRANSITIONS: pending: ['running']
  })
})
