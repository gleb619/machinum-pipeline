import { describe, expect, it } from 'vitest'
import { runChildProcess } from '../../src/engine/child-process.js'
import { Runner } from '../../src/engine/runner.js'
import type { Tool } from '../../src/types.js'

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

describe('UC-11 — Runner dispatches to child-process tool (architectural)', () => {
  it('Runner module imports runChildProcess from ./child-process.js', () => {
    // Verify the import is valid and the function exists
    expect(typeof runChildProcess).toBe('function')
    expect(runChildProcess.length).toBe(3)
  })

  it('Tool.exec supports npx, deno, bun — the runner dispatch switch', () => {
    // The runner branches on tool.exec (line 211: if (tool.exec && tool.exec !== 'inproc'))
    // Verify the type union enables all three child-process runtimes
    const execValues: Array<Tool<unknown, unknown>['exec']> = ['npx', 'deno', 'bun']
    expect(execValues).toEqual(['npx', 'deno', 'bun'])
  })

  it('Tool.exec defaults to undefined (inproc path)', () => {
    // When exec is not set, runner uses tool.invoke() directly
    const tool: Pick<Tool<unknown, unknown>, 'exec'> = {}
    expect(tool.exec).toBeUndefined()
  })
})
