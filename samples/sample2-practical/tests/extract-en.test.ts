import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { CHAPTERS, SAMPLE_DIR, clean, run } from './helpers.js'

const EN_DIR = join(CHAPTERS, 'en')
let hasFailure = false

beforeAll(async () => {
  await clean(EN_DIR, join(SAMPLE_DIR, '.mt'))
})

afterEach(({ task }) => {
  if (task.result?.state === 'fail') hasFailure = true
})

afterAll(async () => {
  if (!hasFailure) await clean(EN_DIR)
})

describe('extract-en', () => {
  it('extracts all 21 chapter documents and skips index/plot', async () => {
    run('extract-en.ts')
    const files = (await readdir(EN_DIR)).filter((file) => file.endsWith('.md')).sort()
    expect(files).toHaveLength(21)
    expect(files).toContain('chapter1.md')
    expect(files).toContain('chapter21.md')
    expect(files.some((file) => file.includes('index') || file.includes('plot'))).toBe(false)
  })

  it('keeps the original chapter text', async () => {
    const first = await readFile(join(EN_DIR, 'chapter1.md'), 'utf-8')
    expect(first.startsWith('# Chapter 1: The Donation\n')).toBe(true)
    expect(first).toContain('Nadia met her under the concrete awning')
  })
})
