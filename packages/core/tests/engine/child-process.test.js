import { spawn } from 'node:child_process'
import { describe, expect, it, vi } from 'vitest'
import { runChildProcess } from '../../src/engine/child-process.js'
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
    vi.mocked(spawn).mockReturnValue(mockChild)
    const result = await runChildProcess({ command: 'npx', args: ['test'] }, { item: 'input' }, {})
    expect(result).toEqual({ item: 'result' })
  })
})
//# sourceMappingURL=child-process.test.js.map
