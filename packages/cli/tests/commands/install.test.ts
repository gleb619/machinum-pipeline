import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Runner } from '@mt/core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Mock } from 'vitest'
import { installCommand } from '../../src/commands/install.js'

vi.mock('@mt/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@mt/core')>()
  return {
    ...actual,
    Runner: vi.fn(),
    importPipelineModule: vi.fn(
      async (filePath: string) => (await import(filePath)) as Record<string, unknown>,
    ),
  }
})

describe('install command', () => {
  let testDir: string
  let originalCwd: string
  let mockStart: Mock

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'mt-install-test-'))
    originalCwd = process.cwd()
    process.chdir(testDir)

    mockStart = vi.fn().mockResolvedValue({ runId: 'install-run-id' })
    vi.mocked(Runner).mockImplementation(
      () =>
        ({
          start: mockStart,
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

  async function writeInstallScript(exportName: string | undefined, id: string): Promise<string> {
    await mkdir(join(testDir, 'scripts'), { recursive: true })
    const scriptPath = join(testDir, 'scripts', 'install.ts')
    const source = exportName
      ? `export const ${exportName} = { id: "${id}" }`
      : `export default { id: "${id}" }`
    await writeFile(scriptPath, source)
    vi.doMock(scriptPath, () => (exportName ? { [exportName]: { id } } : { default: { id } }))
    return scriptPath
  }

  it('exits 1 when scripts.install is not defined in mt.json', async () => {
    await writeFile(join(testDir, 'mt.json'), JSON.stringify({ project: { name: 'p' } }))

    await expect(installCommand([])).rejects.toThrow('EXIT 1')
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('no scripts.install defined in mt.json'),
    )
    expect(mockStart).not.toHaveBeenCalled()
  })

  it('exits 1 when mt.json is missing entirely', async () => {
    await expect(installCommand([])).rejects.toThrow('EXIT 1')
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('no scripts.install defined in mt.json'),
    )
  })

  it('runs the scripts.install pipeline when defined', async () => {
    await writeFile(
      join(testDir, 'mt.json'),
      JSON.stringify({
        project: { name: 'p' },
        scripts: { install: './scripts/install.ts' },
      }),
    )
    await writeInstallScript(undefined, 'install-pipeline')

    await installCommand([])

    expect(Runner).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'install-pipeline' }),
      expect.objectContaining({ project: expect.objectContaining({ name: 'p' }) }),
      expect.objectContaining({ pipelineFile: join('scripts', 'install.ts') }),
    )
    expect(mockStart).toHaveBeenCalled()
  })

  it('supports --pipeline for named exports', async () => {
    await writeFile(
      join(testDir, 'mt.json'),
      JSON.stringify({
        project: { name: 'p' },
        scripts: { install: './scripts/install.ts' },
      }),
    )
    await writeInstallScript('setup', 'setup-pipeline')

    await installCommand(['--pipeline', 'setup'])

    expect(Runner).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'setup-pipeline' }),
      expect.anything(),
      expect.objectContaining({ pipelineName: 'setup' }),
    )
    expect(mockStart).toHaveBeenCalled()
  })

  it('exits 1 with a clear message when the script file is missing', async () => {
    await writeFile(
      join(testDir, 'mt.json'),
      JSON.stringify({
        project: { name: 'p' },
        scripts: { install: './scripts/gone.ts' },
      }),
    )

    await expect(installCommand([])).rejects.toThrow('EXIT 1')
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining("Cannot load lifecycle script './scripts/gone.ts' (install)"),
    )
    expect(mockStart).not.toHaveBeenCalled()
  })
})
