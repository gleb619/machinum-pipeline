import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { listRunsCommand } from '../../src/commands/list.js'

describe('list runs command', () => {
  let testDir: string
  let originalCwd: string

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'mt-list-test-'))
    originalCwd = process.cwd()

    // Set up mock filesystem structure
    await mkdir(join(testDir, '.mt', 'runs', 'run1'), { recursive: true })
    await writeFile(
      join(testDir, '.mt', 'runs', 'run1', 'state.json'),
      JSON.stringify({
        runId: 'run1',
        pipelineId: 'pipe1',
        state: 'running',
        startedAt: '2026-04-30T10:00:00Z',
      }),
    )

    process.chdir(testDir)

    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'table').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(process, 'exit').mockImplementation((code) => {
      throw new Error(`EXIT ${code}`)
    })
  })

  afterEach(async () => {
    process.chdir(originalCwd)
    await rm(testDir, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  it('lists runs in a table', async () => {
    await listRunsCommand([])
    expect(console.table).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({
          RunID: 'run1',
          Pipeline: 'pipe1',
          State: 'running',
        }),
      ]),
    )
  })

  it('handles empty runs directory', async () => {
    await rm(join(testDir, '.mt', 'runs', 'run1'), { recursive: true })
    await listRunsCommand([])
    expect(console.log).toHaveBeenCalledWith('No runs found.')
  })
})
