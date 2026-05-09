import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { execSync } from 'node:child_process'
import { access, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'

const SAMPLE_DIR = resolve(import.meta.dirname, '..')
const CORE_SRC = resolve(SAMPLE_DIR, '..', '..', 'packages', 'core')
const CLI_SRC = resolve(SAMPLE_DIR, '..', '..', 'packages', 'cli')

let tempDir: string

beforeAll(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'mt-init-test-'))
  const vendorDir = join(tempDir, 'vendor')
  await mkdir(vendorDir, { recursive: true })

  execSync(`pnpm -C "${CORE_SRC}" pack --pack-destination "${vendorDir}"`, { stdio: 'pipe' })
  execSync(`pnpm -C "${CLI_SRC}" pack --pack-destination "${vendorDir}"`, { stdio: 'pipe' })

  const pkgJson = {
    name: 'sample0-test',
    type: 'module',
    dependencies: {
      '@mt/core': 'file:./vendor/mt-core-0.1.0.tgz',
      '@mt/cli': 'file:./vendor/mt-cli-0.1.0.tgz',
    },
  }
  await writeFile(join(tempDir, 'package.json'), JSON.stringify(pkgJson, null, 2))
  execSync('npm install --no-audit --no-fund', { cwd: tempDir, stdio: 'pipe' })
}, 60_000)

afterAll(async () => {
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true })
  }
})

describe('mt init', () => {
  it('scaffolds a project in cwd', () => {
    const mtBin = join(tempDir, 'node_modules', '.bin', 'mt')
    execSync(`"${mtBin}" init sample-project`, { cwd: tempDir, stdio: 'pipe' })
  })

  it('creates mt.json with correct project name', async () => {
    const content = await readFile(join(tempDir, 'mt.json'), 'utf-8')
    const config = JSON.parse(content)
    expect(config.project?.name).toBe('sample-project')
  })

  it('creates .mt/ with runs/ and cache/', async () => {
    await access(join(tempDir, '.mt'))
    await access(join(tempDir, '.mt', 'runs'))
    await access(join(tempDir, '.mt', 'cache'))
  })

  it('creates pipelines/example.ts with definePipeline', async () => {
    const content = await readFile(join(tempDir, 'pipelines', 'example.ts'), 'utf-8')
    expect(content).toContain('definePipeline')
    expect(content).toContain("id: 'example'")
  })
})
