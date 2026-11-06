import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { CHAPTERS, SAMPLE_DIR, clean, run } from './helpers.js'

const SCHEMA_DIR = join(CHAPTERS, 'schema')
let hasFailure = false

beforeAll(async () => {
  await clean(SCHEMA_DIR, join(SAMPLE_DIR, '.mt'))
  run('summary.ts', { env: { MT_ONLY_CHAPTERS: '1,2' } })
}, 60_000)

afterEach(({ task }) => {
  if (task.result?.state === 'fail') hasFailure = true
})

afterAll(async () => {
  if (!hasFailure) await clean(SCHEMA_DIR)
})

describe('summary', () => {
  it('writes one summary per selected chapter', async () => {
    expect((await readdir(SCHEMA_DIR)).filter((file) => file.endsWith('.md')).sort()).toEqual([
      'chapter1.summary.md',
      'chapter2.summary.md',
    ])
  })

  it('keeps the chapter title and a Summary section', async () => {
    const summary = await readFile(join(SCHEMA_DIR, 'chapter1.summary.md'), 'utf-8')
    expect(summary).toContain('# Chapter 1: The Donation')
    expect(summary).toContain('## Summary')
    expect(summary.length).toBeGreaterThan(100)
  })
})
