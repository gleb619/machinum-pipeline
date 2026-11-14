import { existsSync } from 'node:fs'
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { type StatsArtifact, bodyCharsOf } from '../lib/stats.js'
import { CHAPTERS, SAMPLE_DIR, clean, run } from './helpers.js'

const SCHEMA_DIR = join(CHAPTERS, 'schema')
const STATS_FILE = join(SCHEMA_DIR, 'stats.json')
const BOOK_DIR = join(SAMPLE_DIR, '..', '..', 'books', 'book2')
const CHAPTER_COUNT = 21

let hasFailure = false
let firstRun = ''

beforeAll(async () => {
  await clean(STATS_FILE, join(SAMPLE_DIR, '.mt'))
  run('stats.ts', { timeout: 120_000 })
  firstRun = await readFile(STATS_FILE, 'utf-8')
}, 120_000)

afterEach(({ task }) => {
  if (task.result?.state === 'fail') hasFailure = true
})

afterAll(async () => {
  if (!hasFailure) await clean(STATS_FILE, join(SAMPLE_DIR, '.mt'))
})

function parse(): StatsArtifact {
  return JSON.parse(firstRun) as StatsArtifact
}

describe('stats', () => {
  it('measures every chapter and writes a sane book summary', () => {
    const stats = parse()
    expect(stats.version).toBe(1)
    expect(stats.unit).toBe('bodyChars')
    expect(stats.factor).toBe(1.5)
    expect(stats.book.chapters).toBe(CHAPTER_COUNT)
    expect(stats.chapters).toHaveLength(CHAPTER_COUNT)
    expect(stats.chapters.map((chapter) => chapter.n)).toEqual(
      Array.from({ length: CHAPTER_COUNT }, (_, index) => index + 1),
    )
    expect(stats.chapters.map((chapter) => chapter.id)).toEqual(
      Array.from({ length: CHAPTER_COUNT }, (_, index) => String(index + 1)),
    )
    expect(stats.oversize).toEqual([])
    expect(stats.chapters.every((chapter) => chapter.ratioToMean < 1.5)).toBe(true)
    expect(stats.book.mean).toBeGreaterThan(0)
    expect(stats.book.median).toBeGreaterThan(0)
    expect(stats.book.threshold).toBeCloseTo(stats.book.mean * stats.factor, 4)
    expect(stats.book.totalWords).toBe(
      stats.chapters.reduce((sum, chapter) => sum + chapter.words, 0),
    )
    expect(stats.book.totalTokens).toBe(
      stats.chapters.reduce((sum, chapter) => sum + chapter.tokens, 0),
    )
  })

  it('uses the shared bodyChars definition (markdown minus the H1 line)', async () => {
    const stats = parse()
    for (const chapter of stats.chapters) {
      const markdown = await readFile(join(BOOK_DIR, `chapter-${chapter.n}.en.md`), 'utf-8')
      expect(chapter.bodyChars).toBe(bodyCharsOf(markdown))
    }
  })

  it('is byte-identical on a second run', async () => {
    run('stats.ts', { timeout: 120_000 })
    expect(await readFile(STATS_FILE, 'utf-8')).toBe(firstRun)
  })

  it('writes only chapters/schema/stats.json', async () => {
    expect(existsSync(STATS_FILE)).toBe(true)
    const schemaFiles = (await readdir(SCHEMA_DIR)).filter((file) => file !== '.gitkeep').sort()
    expect(schemaFiles).toEqual(['stats.json'])
    const ruFiles = (await readdir(join(CHAPTERS, 'ru')).catch(() => [])).filter((file) =>
      file.endsWith('.md'),
    )
    expect(ruFiles).toEqual([])
    expect(existsSync(join(CHAPTERS, 'book'))).toBe(false)
    expect(existsSync(join(CHAPTERS, 'titles.json'))).toBe(false)
  })
})
