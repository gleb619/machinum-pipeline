import { spawn } from 'node:child_process'
import { describe, expect, it, vi } from 'vitest'
import type { ToolContext } from '../../src/contexts.js'
import { runChildProcess, streamChildProcess } from '../../src/engine/child-process.js'
import type { Envelope } from '../../src/types.js'

vi.mock('node:child_process', () => ({
  spawn: vi.fn(),
}))

describe('child-process', () => {
  it('runChildProcess should execute and parse response', async () => {
    const mockChild = {
      stdout: {
        on: vi.fn(
          (event, cb) => event === 'data' && cb(Buffer.from(JSON.stringify({ item: 'result' }))),
        ),
      },
      stderr: { on: vi.fn() },
      on: vi.fn((event, cb) => event === 'close' && cb(0)),
      stdin: { write: vi.fn(), end: vi.fn() },
    }
    vi.mocked(spawn).mockReturnValue(mockChild as any)

    const result = await runChildProcess(
      { command: 'npx', args: ['test'] },
      { item: 'input' } as Envelope<any>,
      {} as ToolContext,
    )

    expect(result).toEqual({ item: 'result' })
  })
})
