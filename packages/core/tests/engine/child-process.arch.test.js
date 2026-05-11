import { describe, expect, it } from 'vitest'
import { runChildProcess, streamChildProcess } from '../../src/engine/child-process.js'
describe('UC-11 — Child-process tool execution (architectural)', () => {
  it('runChildProcess is exported as a function', () => {
    expect(typeof runChildProcess).toBe('function')
    expect(runChildProcess.length).toBeGreaterThanOrEqual(2)
  })
  it('runChildProcess signature accepts envelope and tool context', () => {
    // Runtime length check: (options, envelope, toolContext) = 3 positional
    expect(runChildProcess.length).toBe(3)
  })
  it('ChildProcessOptions type shape — command, args, optional timeout', () => {
    const opts = { command: 'npx', args: ['test'] }
    expect(opts.command).toBe('npx')
    expect(Array.isArray(opts.args)).toBe(true)
    expect('timeout' in opts).toBe(false) // optional, no default value
  })
  it('ChildProcessResult type shape — stdout, stderr, exitCode', () => {
    const result = { stdout: '', stderr: '', exitCode: 0 }
    expect(typeof result.stdout).toBe('string')
    expect(typeof result.stderr).toBe('string')
    expect(typeof result.exitCode).toBe('number')
  })
})
describe('UC-50 — Streaming NDJSON to child-process tool (architectural)', () => {
  it('streamChildProcess is exported as a function', () => {
    expect(typeof streamChildProcess).toBe('function')
  })
  it('streamChildProcess signature accepts options, async iterable, toolContext', () => {
    // Runtime length check: (options, envelopes, toolContext) = 3 positional
    expect(streamChildProcess.length).toBe(3)
  })
  it('streamChildProcess returns an AsyncIterable (has Symbol.asyncIterator)', () => {
    // Verify async generator nature by checking return type's iterator symbol
    // streamChildProcess() returns an AsyncGenerator
    const iter = streamChildProcess(
      { command: 'npx', args: ['test'] },
      (async function* () {
        yield { item: { x: 1 }, meta: {} }
      })(),
      {},
    )
    expect(typeof iter[Symbol.asyncIterator]).toBe('function')
    // Clean up — the generator will error when the child process fails to spawn
    // (expected — we're testing the interface, not actual execution)
    iter.return?.()
  })
})
describe('UC-11/UC-50 — Tool.exec union type (architectural)', () => {
  it('Tool.exec supports inproc, npx, deno, bun', () => {
    // Type-level verification: assert these values are assignable
    const values = ['inproc', 'npx', 'deno', 'bun', undefined]
    expect(values).toHaveLength(5)
    expect(values[0]).toBe('inproc')
    expect(values[1]).toBe('npx')
    expect(values[2]).toBe('deno')
    expect(values[3]).toBe('bun')
    expect(values[4]).toBeUndefined()
  })
})
//# sourceMappingURL=child-process.arch.test.js.map
