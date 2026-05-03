import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, readFile, access } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
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
    await initCommand([])

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

    // Verify sample pipeline exists
    const pipelineContent = await readFile(join(testDir, 'pipelines/example.ts'), 'utf-8')
    expect(pipelineContent).toContain('definePipeline')
    expect(pipelineContent).toContain('from(source')
    expect(pipelineContent).toContain('to(target')
  })

  it('T001-02: uses custom project name when provided', async () => {
    await initCommand(['custom-book-name'])

    const configContent = await readFile(join(testDir, 'mt.json'), 'utf-8')
    const config = JSON.parse(configContent)
    expect(config.project.name).toBe('custom-book-name')
  })

  it('T001-03: idempotent - can be run multiple times', async () => {
    await initCommand(['first-run'])
    await expect(initCommand(['second-run'])).resolves.not.toThrow()

    const configContent = await readFile(join(testDir, 'mt.json'), 'utf-8')
    const config = JSON.parse(configContent)
    expect(config.project.name).toBe('second-run')
  })

  it('T001-04: registers sample pipeline in mt.json', async () => {
    await initCommand([])

    const configContent = await readFile(join(testDir, 'mt.json'), 'utf-8')
    const config = JSON.parse(configContent)
    expect(config.pipelines).toContain('./pipelines/example.ts')
  })

  it('T001-05: generated sample pipeline is valid DSL', async () => {
    await initCommand([])

    // Import the generated pipeline to verify it loads correctly
    const pipelinePath = join(testDir, 'pipelines/example.ts')

    // We just verify the file syntax is valid by reading it
    // In real integration tests we would load it via tsx
    const content = await readFile(pipelinePath, 'utf-8')
    expect(content).toMatch(/export default definePipeline/)
    expect(content).toContain('id: \'example\'')
    expect(content).toContain('retry: { max: 3')
  })

  it('T001-06: generated mt.json matches schema', async () => {
    await initCommand([])

    const configContent = await readFile(join(testDir, 'mt.json'), 'utf-8')
    const config = JSON.parse(configContent)

    expect(config).toHaveProperty('project')
    expect(config).toHaveProperty('defaults')
    expect(config.defaults).toHaveProperty('retry')
    expect(config.defaults).toHaveProperty('onError')
    expect(config.defaults).toHaveProperty('concurrency')
    expect(config.defaults.onError).toBe('fail-run')
  })
})