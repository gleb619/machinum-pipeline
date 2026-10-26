import type { PathLike } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { inspectCommand } from '../../src/commands/inspect.js'

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    readFile: vi.fn(),
  }
})

describe('inspectCommand', () => {
  const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
  const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
  const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => ({}) as never)

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('should error if no runId is provided', async () => {
    await inspectCommand([])
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Usage: mt inspect <runId>'))
    expect(exitSpy).toHaveBeenCalledWith(1)
  })

  it('should error if runId is not found', async () => {
    vi.mocked(readFile).mockRejectedValue({ code: 'ENOENT' })
    await inspectCommand(['missing-id'])
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Run "missing-id" not found'))
    expect(exitSpy).toHaveBeenCalledWith(1)
  })

  it('should display run info and checkpoint tree', async () => {
    const mockState = {
      runId: 'test-run-123',
      pipelineId: 'test-pipeline',
      state: 'done',
      startedAt: '2026-04-30T10:00:00.000Z',
      updatedAt: '2026-04-30T10:05:00.000Z',
      checkpoint: {
        stepId: 'root',
        state: 'done',
        children: [
          { stepId: 'source-1', state: 'done' },
          {
            stepId: 'tool-1',
            state: 'in-progress',
            children: [{ stepId: 'fork-1', state: 'pending' }],
          },
        ],
      },
    }

    vi.mocked(readFile).mockImplementation(async (path) => {
      if ((path as PathLike | URL).toString().endsWith('state.json')) {
        return JSON.stringify(mockState)
      }
      throw { code: 'ENOENT' }
    })

    await inspectCommand(['test-run-123'])

    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Inspecting Run: test-run-123'))
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Pipeline:  test-pipeline'))
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('State:     DONE'))
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Checkpoint Tree:'))
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('✅ root'))
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('  ✅ source-1'))
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('  ⏳ tool-1'))
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('    ◻️ fork-1'))
  })

  it('should show the last log entries of the run log', async () => {
    const mockState = {
      runId: 'test-run-123',
      pipelineId: 'test-pipeline',
      state: 'done',
      startedAt: '2026-04-30T10:00:00.000Z',
      updatedAt: '2026-04-30T10:05:00.000Z',
      checkpoint: { stepId: 'root', state: 'done' },
    }
    const logLines = Array.from({ length: 8 }, (_, index) => `log line ${index + 1}`)

    vi.mocked(readFile).mockImplementation(async (path) => {
      const filePath = (path as PathLike | URL).toString()
      if (filePath.endsWith('state.json')) {
        return JSON.stringify(mockState)
      }
      if (filePath.endsWith('run.log')) {
        return logLines.join('\n')
      }
      throw { code: 'ENOENT' }
    })

    await inspectCommand(['test-run-123'])

    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Last Log Entries:'))
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('log line 8'))
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('log line 4'))
    expect(consoleSpy).not.toHaveBeenCalledWith(expect.stringContaining('log line 3'))
  })
})
