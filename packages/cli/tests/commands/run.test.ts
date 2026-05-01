import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Runner } from '@mt/core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runCommand } from '../../src/commands/run.js'

vi.mock('@mt/core', () => ({
  Runner: vi.fn(),
  definePipeline: vi.fn(),
}))

describe('run command', () => {
  let testDir: string
  let originalCwd: string
  let mockStart: any

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'mt-run-test-'))
    originalCwd = process.cwd()
    process.chdir(testDir)

    mockStart = vi.fn().mockResolvedValue({ runId: 'test-run-id' })
    vi.mocked(Runner).mockImplementation(
      () =>
        ({
          start: mockStart,
        }) as any,
    )

    vi.spyOn(console, 'log').mockImplementation(() => {})
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

  it('fails if no pipeline file is provided', async () => {
    await expect(runCommand([])).rejects.toThrow('EXIT 1')
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('Usage: mt run'))
  })

  it('runs a valid pipeline', async () => {
    const pipelinePath = join(testDir, 'pipeline.ts')
    await writeFile(pipelinePath, 'export default { id: "test-pipeline" }')

    vi.doMock(pipelinePath, () => ({
      default: { id: 'test-pipeline' },
    }))

    await runCommand(['pipeline.ts'])

    expect(mockStart).toHaveBeenCalled()
    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining('Pipeline complete. Run ID: test-run-id'),
    )
  })

  it('loads global context from mt.json if present', async () => {
    const pipelinePath = join(testDir, 'pipeline.ts')
    await writeFile(pipelinePath, 'export default { id: "test-pipeline" }')
    vi.doMock(pipelinePath, () => ({
      default: { id: 'test-pipeline' },
    }))

    const mtJsonPath = join(testDir, 'mt.json')
    await writeFile(
      mtJsonPath,
      JSON.stringify({
        project: { name: 'custom-project' },
        defaults: { concurrency: 10 },
      }),
    )

    await runCommand(['pipeline.ts'])

    expect(Runner).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'test-pipeline' }),
      expect.objectContaining({
        project: expect.objectContaining({ name: 'custom-project' }),
        defaults: expect.objectContaining({ concurrency: 10 }),
      }),
    )
  })

  it('handles runner failure', async () => {
    const pipelinePath = join(testDir, 'pipeline.ts')
    await writeFile(pipelinePath, 'export default { id: "test-pipeline" }')
    vi.doMock(pipelinePath, () => ({
      default: { id: 'test-pipeline' },
    }))

    mockStart.mockRejectedValue(new Error('Runner failed'))

    await expect(runCommand(['pipeline.ts'])).rejects.toThrow('EXIT 1')
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('Pipeline failed: Runner failed'),
    )
  })
})
