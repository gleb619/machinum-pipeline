import { describe, expect, it } from 'vitest'
import { Runner } from '../../src/engine/runner.js'

describe('UC-05/06/07 — Runner lifecycle (architectural)', () => {
  it('Runner exposes start() method', () => {
    expect(typeof Runner.prototype.start).toBe('function')
  })

  it('Runner exposes pause() method', () => {
    expect(typeof Runner.prototype.pause).toBe('function')
  })

  it('Runner exposes unpause() method', () => {
    expect(typeof Runner.prototype.unpause).toBe('function')
  })

  it('Runner exposes resume(runId) method', () => {
    expect(typeof Runner.prototype.resume).toBe('function')
    expect(Runner.prototype.resume.length).toBeGreaterThanOrEqual(1)
  })

  it('Runner exposes getRunId() method', () => {
    expect(typeof Runner.prototype.getRunId).toBe('function')
  })
})
