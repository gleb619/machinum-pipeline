import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Runner } from '@mt/core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Mock } from 'vitest'
import { resumeCommand } from '../../src/commands/resume.js'

vi.mock('@mt/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@mt/core')>()
  return {
    ...actual,
    Runner: vi.fn(),
    definePipeline: vi.fn(),
    importPipelineModule: vi.fn(
      async (filePath: string) => (await import(filePath)) as Record<string, unknown>,
    ),
    nativeAddonHint: () => '',
    packageResolutionHint: () => '',
  }
})

describe('resume command', () => {
  let testDir: string
  let originalCwd: string
  let mockResume: Mock

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'mt-resume-test-'))
    originalCwd = process.cwd()
    process.chdir(testDir)

    mockResume = vi.fn().mockResolvedValue({ runId: 'test-run-id' })
    vi.mocked(Runner).mockImplementation(
      () =>
        ({
          resume: mockResume,
        }) as unknown as Runner,
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

  it('fails if no runId is provided', async () => {
    await expect(resumeCommand([])).rejects.toThrow('EXIT 1')
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('Usage: mt resume <runId> [pipeline.ts]'),
    )
  })

  it('resumes from the pipeline file recorded in state.json when no file arg is given', async () => {
    const pipelinePath = join(testDir, 'pipeline.ts')
    await writeFile(pipelinePath, 'export default { id: "test-pipeline" }')
    const runDir = join(testDir, '.mt', 'runs', 'test-run-id')
    const { mkdir } = await import('node:fs/promises')
    await mkdir(runDir, { recursive: true })
    await writeFile(
      join(runDir, 'state.json'),
      JSON.stringify({
        runId: 'test-run-id',
        pipelineId: 'test-pipeline',
        pipelineFile: 'pipeline.ts',
        state: 'paused',
        startedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        checkpoint: { stepId: 'root' },
        contextRef: 'runs/test-run-id/context.json',
      }),
    )

    await resumeCommand(['test-run-id'])

    expect(mockResume).toHaveBeenCalledWith('test-run-id')
    expect(vi.mocked(Runner)).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'test-pipeline' }),
      expect.anything(),
      { pipelineFile: 'pipeline.ts', pipelineName: undefined },
    )
    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining('Pipeline resumed and complete. Run ID: test-run-id'),
    )
  })

  it('errors helpfully when runId-only resume finds no recorded pipelineFile', async () => {
    const runDir = join(testDir, '.mt', 'runs', 'old-run-id')
    const { mkdir } = await import('node:fs/promises')
    await mkdir(runDir, { recursive: true })
    await writeFile(
      join(runDir, 'state.json'),
      JSON.stringify({
        runId: 'old-run-id',
        pipelineId: 'old-pipeline',
        state: 'paused',
        startedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        checkpoint: { stepId: 'root' },
        contextRef: 'runs/old-run-id/context.json',
      }),
    )

    await expect(resumeCommand(['old-run-id'])).rejects.toThrow(/pipelineFile|pipeline file|Usage/i)
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

  it('writes the CLI log to .mt/runs/<runId>/run.log', async () => {
    const pipelinePath = join(testDir, 'pipeline.ts')
    await writeFile(pipelinePath, 'export default { id: "test-pipeline" }')
    vi.doMock(pipelinePath, () => ({
      default: { id: 'test-pipeline' },
    }))

    await resumeCommand(['test-run-id', 'pipeline.ts'])

    const runLog = await readFile(join(testDir, '.mt', 'runs', 'test-run-id', 'run.log'), 'utf-8')
    expect(runLog).toContain('Resuming pipeline: test-pipeline, runId: test-run-id')
    await expect(readFile(join(testDir, '.mt', 'runs', 'run.log'), 'utf-8')).rejects.toThrow()
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

  it('prints the already-done message without a stack when resume rejects (T133)', async () => {
    const pipelinePath = join(testDir, 'pipeline.ts')
    await writeFile(pipelinePath, 'export default { id: "test-pipeline" }')
    vi.doMock(pipelinePath, () => ({
      default: { id: 'test-pipeline' },
    }))

    mockResume.mockRejectedValue(new Error("Run 'test-run-id' is already done; nothing to resume"))

    await expect(resumeCommand(['test-run-id', 'pipeline.ts'])).rejects.toThrow('EXIT 1')
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining("Pipeline resume failed: Run 'test-run-id' is already done"),
    )
    const printed = vi.mocked(console.error).mock.calls.flat().join(' ')
    expect(printed).not.toContain('Invalid state transition')
  })

  it('runs the resume hook before resuming', async () => {
    const pipelinePath = join(testDir, 'pipeline.ts')
    const hookPath = join(testDir, 'resume-hook.ts')
    await writeFile(pipelinePath, 'export default { id: "test-pipeline" }')
    await writeFile(hookPath, 'export default { id: "resume-hook" }')
    vi.doMock(pipelinePath, () => ({ default: { id: 'test-pipeline' } }))
    vi.doMock(hookPath, () => ({ default: { id: 'resume-hook' } }))

    vi.mocked(Runner).mockImplementation(
      () =>
        ({
          start: vi.fn().mockResolvedValue({ runId: 'test-run-id' }),
          resume: mockResume,
        }) as unknown as Runner,
    )

    await writeFile(
      join(testDir, 'mt.json'),
      JSON.stringify({
        project: { name: 'p' },
        scripts: { resume: './resume-hook.ts' },
      }),
    )

    await resumeCommand(['test-run-id', 'pipeline.ts'])

    expect(mockResume).toHaveBeenCalledWith('test-run-id')
    expect(Runner).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'resume-hook' }),
      expect.anything(),
      expect.anything(),
    )
  })
})
