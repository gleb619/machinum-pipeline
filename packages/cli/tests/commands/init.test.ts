import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
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

  it('T001-03: idempotent - can be run multiple times', async () => {
    await initCommand({ projectName: 'first-run' })
    await expect(initCommand({ projectName: 'second-run' })).resolves.not.toThrow()

    const configContent = await readFile(join(testDir, 'mt.json'), 'utf-8')
    const config = JSON.parse(configContent)
    expect(config.project.name).toBe('second-run')
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
    await initCommand({})

    const gitignore = await readFile(join(testDir, '.gitignore'), 'utf-8')
    expect(gitignore).toContain('node_modules/')
    expect(gitignore.match(/^\.mt\/$/gm)).toHaveLength(1)
    expect(gitignore.match(/^vault\.json$/gm)).toHaveLength(1)
    expect(gitignore.match(/^\*\.vault\.json$/gm)).toHaveLength(1)
    expect(gitignore.match(/^\.mt\/vault\*$/gm)).toHaveLength(1)
  })

  it('T116-03: leaves an existing .gitignore untouched when it already covers the patterns', async () => {
    const existing = 'node_modules/\n.mt/\nvault.json\n*.vault.json\n.mt/vault*\n'
    await writeFile(join(testDir, '.gitignore'), existing, 'utf-8')

    await initCommand({})

    expect(await readFile(join(testDir, '.gitignore'), 'utf-8')).toBe(existing)
  })
})
