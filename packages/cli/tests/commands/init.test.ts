import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { initCommand } from '../../src/commands/init.js'

describe('init command (T001)', () => {
  let testDir: string
  let originalCwd: string

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'mt-init-test-'))
    originalCwd = process.cwd()
    process.chdir(testDir)

    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(process, 'exit').mockImplementation(((code: number) => {
      throw new Error(`exit ${code}`)
    }) as () => never)
  })

  afterEach(async () => {
    process.chdir(originalCwd)
    await rm(testDir, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  it('T001-01: creates complete project structure with default name', async () => {
    await initCommand({})

    // Verify mt.json exists and has correct content
    const configContent = await readFile(join(testDir, 'mt.json'), 'utf-8')
    const config = JSON.parse(configContent)
    expect(config.project.name).toBe('my-book-project')
    expect(config.defaults).toBeDefined()
    expect(config.defaults.retry.max).toBe(3)

    // Verify .mt directory structure
    await access(join(testDir, '.mt'))
    await access(join(testDir, '.mt/runs'))
    await access(join(testDir, '.mt/cache'))

    // Sample pipeline should NOT be created without settings
    await expect(access(join(testDir, 'pipelines/example.ts'))).rejects.toThrow()
  })

  it('T001-02: uses custom project name when provided', async () => {
    await initCommand({ projectName: 'custom-book-name' })

    const configContent = await readFile(join(testDir, 'mt.json'), 'utf-8')
    const config = JSON.parse(configContent)
    expect(config.project.name).toBe('custom-book-name')
  })

  it('T001-03: rerun requires --force (T153)', async () => {
    await initCommand({ projectName: 'first-run' })
    await expect(initCommand({ projectName: 'second-run' })).rejects.toThrow('exit 1')

    // File untouched
    const configContent = await readFile(join(testDir, 'mt.json'), 'utf-8')
    const config = JSON.parse(configContent)
    expect(config.project.name).toBe('first-run')

    // With force it overwrites
    await initCommand({ projectName: 'second-run', force: true })
    const forcedContent = await readFile(join(testDir, 'mt.json'), 'utf-8')
    expect(JSON.parse(forcedContent).project.name).toBe('second-run')
  })

  it('T001-04: registers sample pipeline in mt.json when settings provided', async () => {
    await initCommand({ settings: { 'tool.translator.model': 'gpt-4' } })

    const configContent = await readFile(join(testDir, 'mt.json'), 'utf-8')
    const config = JSON.parse(configContent)
    expect(config.pipelines).toContain('./pipelines/example.ts')
    expect(config.settings).toEqual({ 'tool.translator.model': 'gpt-4' })
  })

  it('T001-05: generated sample pipeline is valid DSL when settings provided', async () => {
    await initCommand({ settings: { 'tool.translator.model': 'gpt-4' } })

    const pipelineContent = await readFile(join(testDir, 'pipelines/example.ts'), 'utf-8')
    expect(pipelineContent).toContain('definePipeline')
    expect(pipelineContent).toContain('from(source')
    expect(pipelineContent).toContain('to(target')
  })

  it('T001-06: generated mt.json matches schema', async () => {
    await initCommand({})

    const configContent = await readFile(join(testDir, 'mt.json'), 'utf-8')
    const config = JSON.parse(configContent)

    expect(config).toHaveProperty('project')
    expect(config).toHaveProperty('defaults')
    expect(config.defaults).toHaveProperty('retry')
    expect(config.defaults).toHaveProperty('onError')
    expect(config.defaults).toHaveProperty('concurrency')
    expect(config.defaults.onError).toBe('fail-run')
  })

  it('T001-07: does not create sample pipeline without settings', async () => {
    await initCommand({})

    await expect(access(join(testDir, 'pipelines'))).rejects.toThrow()
  })

  it('T001-08: creates sample pipeline with settings', async () => {
    await initCommand({ settings: { 'waypoint.jsonl.defaultFolder': './data' } })

    await access(join(testDir, 'pipelines'))
    const pipelineContent = await readFile(join(testDir, 'pipelines/example.ts'), 'utf-8')
    expect(pipelineContent).toMatch(/export default definePipeline/)
    expect(pipelineContent).toContain("id: 'example'")
    expect(pipelineContent).toContain('retry: { max: 3')
  })

  it('T001-09: settings are included in mt.json', async () => {
    const testSettings = {
      'tool.translator.model': 'gpt-4',
      'waypoint.jsonl.defaultFolder': './data',
    }
    await initCommand({ settings: testSettings })

    const configContent = await readFile(join(testDir, 'mt.json'), 'utf-8')
    const config = JSON.parse(configContent)
    expect(config.settings).toEqual(testSettings)
  })

  it('T116-01: creates .gitignore with the vault patterns', async () => {
    await initCommand({})

    const gitignore = await readFile(join(testDir, '.gitignore'), 'utf-8')
    expect(gitignore).toContain('.mt/')
    expect(gitignore).toContain('vault.json')
    expect(gitignore).toContain('*.vault.json')
    expect(gitignore).toContain('.mt/vault*')
  })

  it('T116-02: appends only the missing patterns and stays idempotent', async () => {
    await writeFile(join(testDir, '.gitignore'), 'node_modules/\n.mt/\n', 'utf-8')

    await initCommand({})
    await initCommand({ force: true })

    const gitignore = await readFile(join(testDir, '.gitignore'), 'utf-8')
    expect(gitignore).toContain('node_modules/')
    expect(gitignore.match(/^\.mt\/$/gm)).toHaveLength(1)
    expect(gitignore.match(/^vault\.json$/gm)).toHaveLength(1)
    expect(gitignore.match(/^\*\.vault\.json$/gm)).toHaveLength(1)
    expect(gitignore.match(/^\.mt\/vault\*$/gm)).toHaveLength(1)
  })

  it('T153-01: refuses to overwrite an edited mt.json and exits 1', async () => {
    await initCommand({})
    const edited = '{"project":{"name":"edited"}}\n'
    await writeFile(join(testDir, 'mt.json'), edited, 'utf-8')

    await expect(initCommand({})).rejects.toThrow('exit 1')

    expect(await readFile(join(testDir, 'mt.json'), 'utf-8')).toBe(edited)
  })

  it('T153-02: --force overwrites an existing mt.json', async () => {
    await initCommand({})
    const edited = '{"project":{"name":"edited"}}\n'
    await writeFile(join(testDir, 'mt.json'), edited, 'utf-8')

    await initCommand({ force: true })

    const config = JSON.parse(await readFile(join(testDir, 'mt.json'), 'utf-8'))
    expect(config.project.name).toBe('my-book-project')
  })

  it('T153-03: keeps an existing pipelines/example.ts without --force', async () => {
    await mkdir(join(testDir, 'pipelines'), { recursive: true })
    const edited = '// my custom pipeline\n'
    await writeFile(join(testDir, 'pipelines/example.ts'), edited, 'utf-8')

    await expect(initCommand({ settings: { 'tool.translator.model': 'gpt-4' } })).rejects.toThrow(
      'exit 1',
    )

    expect(await readFile(join(testDir, 'pipelines/example.ts'), 'utf-8')).toBe(edited)
    // mt.json must not have been written either
    await expect(access(join(testDir, 'mt.json'))).rejects.toThrow()
  })

  it('T153-04: --force overwrites an existing pipelines/example.ts', async () => {
    await mkdir(join(testDir, 'pipelines'), { recursive: true })
    const edited = '// my custom pipeline\n'
    await writeFile(join(testDir, 'pipelines/example.ts'), edited, 'utf-8')

    await initCommand({ settings: { 'tool.translator.model': 'gpt-4' }, force: true })

    const pipelineContent = await readFile(join(testDir, 'pipelines/example.ts'), 'utf-8')
    expect(pipelineContent).toContain('definePipeline')
    expect(pipelineContent).not.toBe(edited)
  })

  it('T153-05: error message names the existing file and --force', async () => {
    await initCommand({})

    let errorOutput = ''
    vi.spyOn(console, 'error').mockImplementation((msg: unknown) => {
      errorOutput += String(msg)
    })

    await expect(initCommand({})).rejects.toThrow('exit 1')

    expect(errorOutput).toContain('mt.json')
    expect(errorOutput).toContain('--force')
  })

  it('T116-03: leaves an existing .gitignore untouched when it already covers the patterns', async () => {
    const existing = 'node_modules/\n.mt/\nvault.json\n*.vault.json\n.mt/vault*\n*.kdbx\n'
    await writeFile(join(testDir, '.gitignore'), existing, 'utf-8')

    await initCommand({})

    expect(await readFile(join(testDir, '.gitignore'), 'utf-8')).toBe(existing)
  })
})
