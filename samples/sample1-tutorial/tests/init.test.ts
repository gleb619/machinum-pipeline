import { execFileSync } from 'node:child_process'
import { access, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MT_BIN } from './helpers.js'

/**
 * `mt init` scaffold test (the old sample0 lesson). It runs in a throwaway directory, so the
 * tutorial's own `mt.json` is never touched.
 */
let projectDir = ''

beforeAll(async () => {
  projectDir = await mkdtemp(join(tmpdir(), 'mt-init-'))
})

afterAll(async () => {
  if (projectDir !== '') await rm(projectDir, { recursive: true, force: true })
})

describe('mt init', () => {
  it('scaffolds mt.json, .mt/ and an example pipeline', async () => {
    execFileSync(
      MT_BIN,
      ['init', 'sample-project', '--settings', JSON.stringify({ 'sample.test': true })],
      { cwd: projectDir, env: process.env, stdio: 'pipe', timeout: 15_000 },
    )

    const config = JSON.parse(await readFile(join(projectDir, 'mt.json'), 'utf-8')) as {
      project?: { name?: string }
      settings?: Record<string, unknown>
    }
    expect(config.project?.name).toBe('sample-project')
    expect(config.settings?.['sample.test']).toBe(true)

    await access(join(projectDir, '.mt'))
    await access(join(projectDir, '.mt', 'runs'))
    await access(join(projectDir, '.mt', 'cache'))

    const pipeline = await readFile(join(projectDir, 'pipelines', 'example.ts'), 'utf-8')
    expect(pipeline).toContain('definePipeline')
    expect(pipeline).toContain("id: 'example'")
  })
})
