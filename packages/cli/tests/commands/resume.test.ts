import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Runner } from '@mt/core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resumeCommand } from '../../src/commands/resume.js'

vi.mock('@mt/core', () => ({
  Runner: vi.fn(),
  definePipeline: vi.fn(),
}))

describe('resume command', () => {
  let testDir: string
  let originalCwd: string
  let mockResume: any

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'mt-resume-test-'))
    originalCwd = process.cwd()
    process.chdir(testDir)

    mockResume = vi.fn().mockResolvedValue({ runId: 'test-run-id' })
    vi.mocked(Runner).mockImplementation(
      () =>
        ({
          resume: mockResume,
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

  it('fails if no runId and pipeline file are provided', async () => {
    await expect(resumeCommand([])).rejects.toThrow('EXIT 1')
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('Usage: mt resume <runId> <pipeline.ts>'),
    )
  })

  it('resumes a valid pipeline', async () => {
    const pipelinePath = join(testDir, 'pipeline.ts')
    await writeFile(pipelinePath, 'export default { id: "test-pipeline" }')

    vi.doMock(pipelinePath, () => ({
      default: { id: 'test-pipeline' },
    }))

    await resumeCommand(['test-run-id', 'pipeline.ts'])

    expect(mockResume).toHaveBeenCalledWith('test-run-id')
    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining('Pipeline resumed and complete. Run ID: test-run-id'),
    )
  })

  it('handles resume failure', async () => {
    const pipelinePath = join(testDir, 'pipeline.ts')
    await writeFile(pipelinePath, 'export default { id: "test-pipeline" }')
    vi.doMock(pipelinePath, () => ({
      default: { id: 'test-pipeline' },
    }))

    mockResume.mockRejectedValue(new Error('Runner failed'))

    await expect(resumeCommand(['test-run-id', 'pipeline.ts'])).rejects.toThrow('EXIT 1')
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('Pipeline resume failed: Runner failed'),
    )
  })
})
