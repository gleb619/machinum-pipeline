import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Logger } from '@mt/core'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { bookSource } from '../lib/input.js'
import { type QualityArtifact, THRESHOLDS } from '../lib/quality.js'
import { type ChapterMeasure, bodyCharsOf, buildStats } from '../lib/stats.js'
import { CHAPTERS, SAMPLE_DIR, clean, run, writeFileAt } from './helpers.js'

const SCHEMA_DIR = join(CHAPTERS, 'schema')
const QUALITY_FILE = join(SCHEMA_DIR, 'quality.json')
const STATS_FILE = join(SCHEMA_DIR, 'stats.json')
const MAP_FILE = join(SCHEMA_DIR, 'chapter-map.json')
const SPLIT_DIR = join(CHAPTERS, 'split')
const BOOK_DIR = join(SAMPLE_DIR, '..', '..', 'books', 'book2')
const CHAPTER_COUNT = 21

/**
 * A backend that throws if it is ever used: the gate is CPU-only. Port 1 is closed, so any
 * resolved model or issued request would fail the run instead of passing silently.
 */
const NO_LLM_ENV = {
  MT_LLM_TOOL: 'router',
  MT_LLM_MODEL: 'stub:free',
  MT_ROUTER_URL: 'http://127.0.0.1:1',
}

const TYPO_LINE = 'He recieved the definately seperate adress and occured wich untill.'

let hasFailure = false
let dirtyRoot = ''
let cleanRun = ''
let artifact: QualityArtifact

function parse(text: string): QualityArtifact {
  return JSON.parse(text) as QualityArtifact
}

function round2(value: number): number {
  return Math.round(value * 100) / 100
}

function measure(n: number, markdown: string): ChapterMeasure {
  return {
    n,
    id: String(n),
    words: markdown.split(/\s+/).filter(Boolean).length,
    bodyChars: bodyCharsOf(markdown),
    tokens: 0,
  }
}

function identityMap(count: number): string {
  const map: Record<string, { orig: number; part: number; of: number }> = {}
  for (let n = 1; n <= count; n++) map[String(n)] = { orig: n, part: 1, of: 1 }
  return `${JSON.stringify(map, null, 2)}\n`
}

function captureLogger(): Logger & { warnings: string[] } {
  const warnings: string[] = []
  return {
    warnings,
    info: () => undefined,
    warn: (message: string) => warnings.push(message),
    error: () => undefined,
    debug: () => undefined,
  }
}

/**
 * Three real chapters copied to a temp book. Chapter 1 gets typos + an unbalanced quote,
 * chapter 2 a zero-width char + `<b>` markup + a `Source:` URL, chapter 3 stays clean.
 * Built and removed inside the test file, never committed.
 */
async function buildDirtyFixture(): Promise<{ book: string; out: string }> {
  dirtyRoot = await mkdtemp(join(tmpdir(), 'mt-quality-'))
  const book = join(dirtyRoot, 'book')
  const out = join(dirtyRoot, 'out')

  const first = await readFile(join(BOOK_DIR, 'chapter-1.en.md'), 'utf-8')
  const second = await readFile(join(BOOK_DIR, 'chapter-2.en.md'), 'utf-8')
  const third = await readFile(join(BOOK_DIR, 'chapter-3.en.md'), 'utf-8')

  const dirtyFirst = `${first.trimEnd()}\n\n${TYPO_LINE}\n\n“Nobody saw anything.\n`
  const dirtySecond = `${second.replace(' the ', ' the\u200b ').trimEnd()}\n\n<b>bold</b>\nSource: http://example.com/x\n`

  const texts = [dirtyFirst, dirtySecond, third]
  for (const [index, text] of texts.entries()) {
    await writeFileAt(join(book, `chapter${index + 1}.en.md`), text)
  }
  await writeFileAt(
    join(out, 'schema', 'stats.json'),
    `${JSON.stringify(buildStats(texts.map((text, index) => measure(index + 1, text))), null, 2)}\n`,
  )
  await writeFileAt(join(out, 'schema', 'chapter-map.json'), identityMap(texts.length))
  return { book, out }
}

beforeAll(async () => {
  await clean(QUALITY_FILE, STATS_FILE, MAP_FILE, SPLIT_DIR, join(SAMPLE_DIR, '.mt'))
  run('stats.ts', { timeout: 120_000 })
  run('split.ts', { timeout: 120_000 })
  run('quality.ts', { timeout: 120_000 })
  cleanRun = await readFile(QUALITY_FILE, 'utf-8')
  artifact = parse(cleanRun)
}, 300_000)

afterEach(({ task }) => {
  if (task.result?.state === 'fail') hasFailure = true
})

afterAll(async () => {
  if (dirtyRoot) await rm(dirtyRoot, { recursive: true, force: true })
  if (!hasFailure) {
    await clean(QUALITY_FILE, STATS_FILE, MAP_FILE, SPLIT_DIR, join(SAMPLE_DIR, '.mt'))
  }
})

describe('quality gate', () => {
  it('passes book2: translate verdict, passRate >= 0.9, no hard chapter', () => {
    expect(artifact.version).toBe(1)
    expect(artifact.source).toBe('md://../../books/book2')
    expect(artifact.verdict).toBe('translate')
    expect(artifact.summary.passRate).toBeGreaterThanOrEqual(THRESHOLDS.passRate)
    expect(artifact.summary.hard).toEqual([])
    expect(artifact.chapters).toHaveLength(CHAPTER_COUNT)
    expect(artifact.chapters.map((chapter) => chapter.n)).toEqual(
      Array.from({ length: CHAPTER_COUNT }, (_, index) => index + 1),
    )
    expect(artifact.chapters.every((chapter) => chapter.pass)).toBe(true)
    expect(artifact.chapters.every((chapter) => chapter.reasons.length === 0)).toBe(true)
    expect(Math.max(...artifact.chapters.map((chapter) => chapter.per1kTypos))).toBeLessThanOrEqual(
      THRESHOLDS.typosPer1k,
    )
  })

  it('reports each number with at most two decimals', () => {
    for (const chapter of artifact.chapters) {
      for (const value of [
        chapter.per1kTypos,
        chapter.foreignPct,
        chapter.quotePct,
        chapter.tokPerWord,
      ]) {
        expect(value).toBe(round2(value))
      }
    }
    expect(artifact.summary.passRate).toBe(round2(artifact.summary.passRate))
  })

  it('reruns byte-identically without touching an LLM', async () => {
    const output = run('quality.ts', { env: NO_LLM_ENV, timeout: 120_000 })
    expect(output).not.toMatch(/model=/)
    expect(await readFile(QUALITY_FILE, 'utf-8')).toBe(cleanRun)
  })

  it('flags exactly the dirty chapters and sends the book to preprocess', async () => {
    const { book, out } = await buildDirtyFixture()
    run('quality.ts', {
      env: { MT_QUALITY_BOOK: `md://${book}`, MT_QUALITY_ROOT: `md://${out}` },
      timeout: 120_000,
    })
    const dirty = parse(await readFile(join(out, 'schema', 'quality.json'), 'utf-8'))
    expect(dirty.verdict).toBe('preprocess')
    expect(dirty.source).toBe(`md://${book}`)
    expect(dirty.chapters).toHaveLength(3)
    expect(dirty.summary.passRate).toBe(0.33)
    expect(dirty.summary.hard).toEqual([2])

    const [first, second, third] = dirty.chapters
    expect(first?.n).toBe(1)
    expect(first?.pass).toBe(false)
    expect(first?.reasons).toContain('typos')
    expect(first?.reasons).toContain('quotes')
    expect(first?.per1kTypos).toBeGreaterThan(THRESHOLDS.typosPer1k)

    expect(second?.n).toBe(2)
    expect(second?.pass).toBe(false)
    expect(second?.forbidden).toBeGreaterThan(0)
    expect(second?.leaks).toBeGreaterThan(0)
    expect(second?.reasons).toContain('forbidden')
    expect(second?.reasons).toContain('leaks')

    expect(third?.n).toBe(3)
    expect(third?.pass).toBe(true)
    expect(third?.reasons).toEqual([])

    const schemaFiles = (await readdir(join(out, 'schema'))).sort()
    expect(schemaFiles).toEqual(['chapter-map.json', 'quality.json', 'stats.json'])
  })
})

describe('bookSource', () => {
  const restore = (): void => {
    Reflect.deleteProperty(process.env, 'MT_QUALITY_ROOT')
    Reflect.deleteProperty(process.env, 'MT_FORCE_BRANCH')
  }

  it('returns BOOK2 for the identity/translate case', () => {
    restore()
    expect(bookSource()).toBe('md://../../books/book2')
  })

  it('returns chapters/clean for a preprocess verdict', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mt-branch-'))
    try {
      await writeFileAt(
        join(root, 'schema', 'quality.json'),
        `${JSON.stringify({ version: 1, verdict: 'preprocess' })}\n`,
      )
      await writeFileAt(join(root, 'schema', 'chapter-map.json'), identityMap(2))
      process.env.MT_QUALITY_ROOT = `md://${root}`
      expect(bookSource()).toBe('md://./chapters/clean')
    } finally {
      restore()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('honours MT_FORCE_BRANCH in both directions', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mt-branch-'))
    try {
      await writeFileAt(
        join(root, 'schema', 'quality.json'),
        `${JSON.stringify({ version: 1, verdict: 'translate' })}\n`,
      )
      await writeFileAt(join(root, 'schema', 'chapter-map.json'), identityMap(2))
      process.env.MT_QUALITY_ROOT = `md://${root}`

      process.env.MT_FORCE_BRANCH = 'preprocess'
      expect(bookSource()).toBe('md://./chapters/clean')
      process.env.MT_FORCE_BRANCH = 'translate'
      expect(bookSource()).toBe('md://../../books/book2')
    } finally {
      restore()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('falls back to BOOK2 with exactly one WARN when quality.json is missing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mt-branch-'))
    const logger = captureLogger()
    try {
      process.env.MT_QUALITY_ROOT = `md://${root}`
      expect(bookSource(logger)).toBe('md://../../books/book2')
      expect(logger.warnings).toHaveLength(1)
      expect(logger.warnings[0]).toContain('quality.json missing')
    } finally {
      restore()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('returns the split directory when the split stage produced parts', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mt-branch-'))
    try {
      await writeFileAt(
        join(root, 'schema', 'quality.json'),
        `${JSON.stringify({ version: 1, verdict: 'translate' })}\n`,
      )
      await writeFileAt(
        join(root, 'schema', 'chapter-map.json'),
        `${JSON.stringify({ '1': { orig: 1, part: 1, of: 2 }, '2': { orig: 1, part: 2, of: 2 } })}\n`,
      )
      process.env.MT_QUALITY_ROOT = `md://${root}`
      expect(bookSource()).toBe(`md://${root}/split`)
    } finally {
      restore()
      await rm(root, { recursive: true, force: true })
    }
  })
})
