import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Runner } from '@mt/core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Mock } from 'vitest'
import { runCommand } from '../../src/commands/run.js'

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
    registry: {
      resolveSource: vi.fn(),
      resolveTarget: vi.fn(),
      registerSource: vi.fn(),
      registerTarget: vi.fn(),
      registerComposite: vi.fn(),
      parse: vi.fn(),
      getSourceFactory: vi.fn(),
      getTargetFactory: vi.fn(),
    },
  }
})

describe('run command', () => {
  let testDir: string
  let originalCwd: string
  let mockStart: Mock

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'mt-run-test-'))
    originalCwd = process.cwd()
    process.chdir(testDir)

    mockStart = vi.fn().mockResolvedValue({ runId: 'test-run-id' })
    vi.mocked(Runner).mockImplementation(
      () =>
        ({
          start: mockStart,
          getRunId: () => 'test-run-id',
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
    process.removeAllListeners('SIGINT')
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

  it('writes the CLI log to .mt/runs/<runId>/run.log', async () => {
    const pipelinePath = join(testDir, 'pipeline.ts')
    await writeFile(pipelinePath, 'export default { id: "test-pipeline" }')
    vi.doMock(pipelinePath, () => ({
      default: { id: 'test-pipeline' },
    }))

    await runCommand(['pipeline.ts'])

    const runLog = await vi.waitFor(() =>
      readFile(join(testDir, '.mt', 'runs', 'test-run-id', 'run.log'), 'utf-8'),
    )
    expect(runLog).toContain('Starting pipeline: test-pipeline')
    expect(runLog).toContain('Pipeline completed successfully (runId: test-run-id)')
    await expect(readFile(join(testDir, '.mt', 'runs', 'run.log'), 'utf-8')).rejects.toThrow()
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
        settings: {},
      }),
      expect.anything(),
    )
  })

  it('passes settings from mt.json to global context', async () => {
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
        settings: {
          'waypoint.jsonl.defaultFolder': './custom/jsonl',
          'tool.translator.model': 'gpt-4',
        },
      }),
    )

    await runCommand(['pipeline.ts'])

    expect(Runner).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        settings: {
          'waypoint.jsonl.defaultFolder': './custom/jsonl',
          'tool.translator.model': 'gpt-4',
        },
      }),
      expect.anything(),
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

  describe('lifecycle hooks (scripts.start / scripts.end)', () => {
    async function writeHook(id: string): Promise<string> {
      const scriptPath = join(testDir, `${id}.ts`)
      await writeFile(scriptPath, `export default { id: "${id}" }`)
      vi.doMock(scriptPath, () => ({ default: { id } }))
      return scriptPath
    }

    function recordRunOrder(order: string[]): void {
      vi.mocked(Runner).mockImplementation(
        (pipeline) =>
          ({
            start: vi.fn().mockImplementation(() => {
              order.push((pipeline as { id: string }).id)
              return Promise.resolve({ runId: 'test-run-id' })
            }),
            getRunId: () => 'test-run-id',
          }) as unknown as Runner,
      )
    }

    async function writeMainPipeline(): Promise<void> {
      const pipelinePath = join(testDir, 'pipeline.ts')
      await writeFile(pipelinePath, 'export default { id: "test-pipeline" }')
      vi.doMock(pipelinePath, () => ({
        default: { id: 'test-pipeline' },
      }))
    }

    it('runs start hook before and end hook after the main pipeline', async () => {
      await writeHook('start-hook')
      await writeHook('end-hook')
      await writeMainPipeline()
      await writeFile(
        join(testDir, 'mt.json'),
        JSON.stringify({
          project: { name: 'p' },
          scripts: { start: './start-hook.ts', end: './end-hook.ts' },
        }),
      )
      const order: string[] = []
      recordRunOrder(order)

      await runCommand(['pipeline.ts'])

      expect(order).toEqual(['start-hook', 'test-pipeline', 'end-hook'])
    })

    it('skips hooks when scripts are not defined', async () => {
      await writeMainPipeline()
      await writeFile(join(testDir, 'mt.json'), JSON.stringify({ project: { name: 'p' } }))
      const order: string[] = []
      recordRunOrder(order)

      await runCommand(['pipeline.ts'])

      expect(order).toEqual(['test-pipeline'])
    })

    it('runs the end hook even when the main pipeline fails', async () => {
      await writeHook('end-hook')
      await writeMainPipeline()
      await writeFile(
        join(testDir, 'mt.json'),
        JSON.stringify({ project: { name: 'p' }, scripts: { end: './end-hook.ts' } }),
      )
      const order: string[] = []
      vi.mocked(Runner).mockImplementation(
        (pipeline) =>
          ({
            start: vi.fn().mockImplementation(() => {
              order.push((pipeline as { id: string }).id)
              return (pipeline as { id: string }).id === 'test-pipeline'
                ? Promise.reject(new Error('Runner failed'))
                : Promise.resolve({ runId: 'test-run-id' })
            }),
            getRunId: () => 'test-run-id',
          }) as unknown as Runner,
      )

      await expect(runCommand(['pipeline.ts'])).rejects.toThrow('EXIT 1')
      expect(order).toEqual(['test-pipeline', 'end-hook'])
    })

    it('runs the error hook when the main pipeline fails', async () => {
      await writeHook('error-hook')
      await writeMainPipeline()
      await writeFile(
        join(testDir, 'mt.json'),
        JSON.stringify({ project: { name: 'p' }, scripts: { error: './error-hook.ts' } }),
      )
      const order: string[] = []
      vi.mocked(Runner).mockImplementation(
        (pipeline) =>
          ({
            start: vi.fn().mockImplementation(() => {
              order.push((pipeline as { id: string }).id)
              return (pipeline as { id: string }).id === 'test-pipeline'
                ? Promise.reject(new Error('Runner failed'))
                : Promise.resolve({ runId: 'test-run-id' })
            }),
            getRunId: () => 'test-run-id',
          }) as unknown as Runner,
      )

      await expect(runCommand(['pipeline.ts'])).rejects.toThrow('EXIT 1')
      expect(order).toEqual(['test-pipeline', 'error-hook'])
    })

    it('runs the exit hook after the main pipeline completes', async () => {
      await writeHook('exit-hook')
      await writeMainPipeline()
      await writeFile(
        join(testDir, 'mt.json'),
        JSON.stringify({ project: { name: 'p' }, scripts: { exit: './exit-hook.ts' } }),
      )
      const order: string[] = []
      recordRunOrder(order)

      await runCommand(['pipeline.ts'])

      expect(order).toEqual(['test-pipeline', 'exit-hook'])
    })

    it('runs the stop hook when SIGINT pauses the pipeline', async () => {
      await writeHook('stop-hook')
      await writeMainPipeline()
      await writeFile(
        join(testDir, 'mt.json'),
        JSON.stringify({ project: { name: 'p' }, scripts: { stop: './stop-hook.ts' } }),
      )
      const order: string[] = []
      vi.mocked(Runner).mockImplementation(
        (pipeline) =>
          ({
            start: vi.fn().mockImplementation(() => {
              order.push((pipeline as { id: string }).id)
              return Promise.resolve({ runId: 'test-run-id' })
            }),
            pause: vi.fn().mockResolvedValue(undefined),
            getRunId: () => 'test-run-id',
          }) as unknown as Runner,
      )

      await runCommand(['pipeline.ts'])
      const sigintListeners = process.listeners('SIGINT')
      expect(sigintListeners.length).toBeGreaterThan(0)
      const sigintListener = sigintListeners[0]
      if (!sigintListener) throw new Error('SIGINT listener missing')
      await expect(sigintListener('SIGINT')).rejects.toThrow('EXIT 0')
      expect(order).toEqual(['test-pipeline', 'stop-hook'])

      process.removeAllListeners('SIGINT')
    })
  })
})
