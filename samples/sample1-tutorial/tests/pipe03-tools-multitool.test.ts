import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { CHAPTERS, SAMPLE_DIR, clean, logs, run, runScript } from './helpers.js'

const VERIFIED = join(CHAPTERS, 'verified')
const SUBFLOW = join(CHAPTERS, 'subflow')

let hasFailure = false

async function mdFiles(dir: string): Promise<string[]> {
  return (await readdir(dir)).filter((file) => file.endsWith('.md')).sort()
}

beforeAll(async () => {
  await clean(VERIFIED, SUBFLOW, join(SAMPLE_DIR, '.mt'))
  runScript('prepare-input.ts')
})

afterEach(({ task }) => {
  if (task.result?.state === 'fail') hasFailure = true
})

afterAll(async () => {
  if (!hasFailure) await clean(VERIFIED, SUBFLOW)
})

describe('pipe03 multi-tool chain', () => {
  it('passes one chapter through six tools and writes verified markdown', async () => {
    const stdout = run('pipe03-tools-multitool.ts')
    expect(await mdFiles(VERIFIED)).toEqual([
      'chapter1.md',
      'chapter2.md',
      'chapter3.md',
      'chapter4.md',
    ])
    const checks = logs(stdout).filter((entry) => entry.words !== undefined)
    expect(checks).toHaveLength(4)
    for (const check of checks) {
      expect(Number(check.words)).toBeGreaterThan(0)
      expect(Number(check.tokens)).toBeGreaterThan(0)
      expect(check.valid).toBe(true)
      expect(Number(check.forbidden)).toBe(0)
    }
    const first = await readFile(join(VERIFIED, 'chapter1.md'), 'utf-8')
    expect(first).toContain('# The Quiet Harbour')
  })

  it('batches two chapters at a time for corpus statistics', () => {
    const stdout = run('pipe03-tools-multitool.ts', { pipeline: 'batchPipeline' })
    const batches = logs(stdout).filter((entry) => entry.items !== undefined)
    expect(batches.length).toBeGreaterThan(0)
    expect(batches.every((entry) => Number(entry.items) === 2)).toBe(true)
  })

  it('writes chapters in a subflow and reads them back in a second subflow', async () => {
    run('pipe03-tools-multitool.ts', { pipeline: 'subflowPipeline' })
    expect(await mdFiles(SUBFLOW)).toEqual([
      'chapter1.md',
      'chapter2.md',
      'chapter3.md',
      'chapter4.md',
    ])
  })
})
