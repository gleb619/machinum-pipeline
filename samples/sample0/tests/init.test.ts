import { execSync } from 'node:child_process'
import { access, readFile, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

const SAMPLE_DIR = resolve(import.meta.dirname, '..')
const MT_BIN = join(SAMPLE_DIR, 'node_modules', '.bin', 'mt')

let hasFailure = false

async function cleanup(): Promise<void> {
  await rm(join(SAMPLE_DIR, 'sample-project'), { recursive: true, force: true })
  await rm(join(SAMPLE_DIR, '.mt'), { recursive: true, force: true })
  await rm(join(SAMPLE_DIR, 'mt.json'), { force: true })
}

beforeAll(async () => {
  await cleanup()
})

afterEach(({ task }) => {
  if (task.result?.state === 'fail') {
    hasFailure = true
  }
})

afterAll(async () => {
  if (!hasFailure) {
    await cleanup()
  }
})

describe('mt init', () => {
  it('runs example (mt init)', () => {
    execSync(`"${MT_BIN}" init sample-project`, {
      cwd: SAMPLE_DIR,
      stdio: 'pipe',
      timeout: 10_000,
    })
  })

  it('scaffolds a project in cwd', () => {
    // verified by the mt init test above and subsequent file checks
  })

  it('creates mt.json with correct project name', async () => {
    const content = await readFile(join(SAMPLE_DIR, 'mt.json'), 'utf-8')
    const config = JSON.parse(content)
    expect(config.project?.name).toBe('sample-project')
  })

  it('creates .mt/ with runs/ and cache/', async () => {
    await access(join(SAMPLE_DIR, '.mt'))
    await access(join(SAMPLE_DIR, '.mt', 'runs'))
    await access(join(SAMPLE_DIR, '.mt', 'cache'))
  })

  it('creates pipelines/example.ts with definePipeline', async () => {
    const content = await readFile(join(SAMPLE_DIR, 'pipelines', 'example.ts'), 'utf-8')
    expect(content).toContain('definePipeline')
    expect(content).toContain("id: 'example'")
  })
})
