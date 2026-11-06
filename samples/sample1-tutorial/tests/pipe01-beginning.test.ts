import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { beginnerRecords } from '../lib/fixtures.js'
import { CHAPTERS, SAMPLE_DIR, clean, logs, run, runScript } from './helpers.js'

const OUTPUT = join(CHAPTERS, 'beginner.md')
const TYPED = join(CHAPTERS, 'output-typed.md')
const DOMAIN = join(CHAPTERS, 'output-custom-typed.md')
const RECORDS = beginnerRecords()

let hasFailure = false

beforeAll(async () => {
  await clean(OUTPUT, TYPED, DOMAIN, join(SAMPLE_DIR, '.mt'))
  runScript('prepare-input.ts')
})

afterEach(({ task }) => {
  if (task.result?.state === 'fail') hasFailure = true
})

afterAll(async () => {
  if (!hasFailure) await clean(OUTPUT, TYPED, DOMAIN)
})

describe('pipe01 beginning', () => {
  it('runs from → use → to and writes every input line', async () => {
    run('pipe01-beginning.ts')
    const markdown = await readFile(OUTPUT, 'utf-8')
    for (const record of RECORDS) {
      expect(markdown).toContain(record.text)
    }
  })

  it('counts the words of every record with the shipped wordCounter', () => {
    const stdout = run('pipe01-beginning.ts')
    const countLogs = logs(stdout).filter((entry) => entry.wordCount !== undefined)
    expect(countLogs).toHaveLength(RECORDS.length)
    for (const entry of countLogs) expect(Number(entry.wordCount)).toBeGreaterThan(0)
  })

  it('reports corpus statistics with statFreq', () => {
    const stdout = run('pipe01-beginning.ts', { pipeline: 'statsPipeline' })
    const stats = logs(stdout).find((entry) => entry.totalWords !== undefined)
    expect(Number(stats?.totalWords)).toBeGreaterThan(0)
    expect(Number(stats?.uniqueWords)).toBeGreaterThan(0)
    expect(Number(stats?.uniqueWords)).toBeLessThanOrEqual(Number(stats?.totalWords))
  })

  it('prints every record through the console:// target', () => {
    const stdout = run('pipe01-beginning.ts', { pipeline: 'consolePreviewPipeline' })
    for (const record of RECORDS) {
      for (const line of record.text.split('\n').filter((value) => value.trim() !== '')) {
        expect(stdout).toContain(`[preview] ${line}`)
      }
    }
  })

  it('mutates a typed chapter tree and writes the result', async () => {
    run('pipe01-beginning.ts', { pipeline: 'typedContentPipeline' })
    const markdown = await readFile(TYPED, 'utf-8')
    expect(markdown).toMatch(/^# Edited: Line /m)
    expect(markdown).toContain('<REWRITTEN PARAGRAPH>')
    const firstLine = ((RECORDS[0]?.text ?? '').split('\n')[0] ?? '').toUpperCase()
    expect(firstLine.length).toBeGreaterThan(0)
    expect(markdown).toContain(firstLine)
  })

  it('builds a chapter from the core Chapter type', async () => {
    run('pipe01-beginning.ts', { pipeline: 'chapterDomainPipeline' })
    const markdown = await readFile(DOMAIN, 'utf-8')
    expect(markdown).toContain('# Line 1')
    expect(markdown).toContain('Edited: ')
  })
})
