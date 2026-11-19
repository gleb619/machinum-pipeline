import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chapterNumberOf } from '@mt/tools'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import type { ChapterMapEntry } from '../lib/split-map.js'
import {
  type ChapterMeasure,
  type StatsArtifact,
  bodyCharsOf,
  buildStats,
  chapterBody,
} from '../lib/stats.js'
import { CHAPTERS, SAMPLE_DIR, clean, run, writeFileAt } from './helpers.js'

const SCHEMA_DIR = join(CHAPTERS, 'schema')
const STATS_FILE = join(SCHEMA_DIR, 'stats.json')
const MAP_FILE = join(SCHEMA_DIR, 'chapter-map.json')
const SPLIT_DIR = join(CHAPTERS, 'split')
const BOOK_DIR = join(SAMPLE_DIR, '..', '..', 'books', 'book2')
const CHAPTER_COUNT = 21
const FIXTURE_ORIG = CHAPTER_COUNT

type ChapterMap = Record<string, ChapterMapEntry>
type MappedEntry = { id: number } & ChapterMapEntry

let hasFailure = false
let identityMap = ''
let fixtureRoot = ''
let fixtureBook = ''
let fixtureOut = ''

function measure(n: number, markdown: string): ChapterMeasure {
  return {
    n,
    id: String(n),
    words: markdown.split(/\s+/).filter(Boolean).length,
    bodyChars: bodyCharsOf(markdown),
    tokens: 0,
  }
}

function parseMap(text: string): ChapterMap {
  return JSON.parse(text) as ChapterMap
}

function mappedEntries(map: ChapterMap): MappedEntry[] {
  return Object.entries(map).map(([id, entry]) => ({ id: Number(id), ...entry }))
}

function groupByOrigin(entries: readonly MappedEntry[]): Map<number, MappedEntry[]> {
  const groups = new Map<number, MappedEntry[]>()
  for (const entry of entries) {
    const list = groups.get(entry.orig) ?? []
    list.push(entry)
    groups.set(entry.orig, list)
  }
  return groups
}

/** sha256 of every file under `dir` (fork-free determinism check across a rerun). */
async function snapshot(dir: string): Promise<Record<string, string>> {
  const hashes: Record<string, string> = {}
  async function walk(relative: string): Promise<void> {
    const entries = await readdir(join(dir, relative), { withFileTypes: true })
    for (const entry of entries) {
      const path = join(relative, entry.name)
      if (entry.isDirectory()) {
        await walk(path)
      } else {
        hashes[path] = createHash('sha256')
          .update(await readFile(join(dir, path)))
          .digest('hex')
      }
    }
  }
  await walk('')
  return hashes
}

/**
 * Synthetic book: 20 real book2 chapters plus one chapter holding chapter 3 three times under a
 * single heading (~3× the mean), so the 1.5×-mean rule has something to split. Created and
 * removed inside this test file, never committed.
 */
async function buildFixture(): Promise<number> {
  fixtureRoot = await mkdtemp(join(tmpdir(), 'mt-split-'))
  fixtureBook = join(fixtureRoot, 'book')
  fixtureOut = join(fixtureRoot, 'out')

  const measures: ChapterMeasure[] = []
  for (let n = 1; n < CHAPTER_COUNT; n++) {
    const markdown = await readFile(join(BOOK_DIR, `chapter-${n}.en.md`), 'utf-8')
    await writeFileAt(join(fixtureBook, `chapter${n}.en.md`), markdown)
    measures.push(measure(n, markdown))
  }

  const third = await readFile(join(BOOK_DIR, 'chapter-3.en.md'), 'utf-8')
  const tripled = [chapterBody(third), chapterBody(third), chapterBody(third)].join('\n\n')
  const giant = `# Chapter ${FIXTURE_ORIG}: Giant\n\n${tripled}\n`
  await writeFileAt(join(fixtureBook, `chapter${FIXTURE_ORIG}.en.md`), giant)
  measures.push(measure(FIXTURE_ORIG, giant))

  await writeFileAt(
    join(fixtureOut, 'schema', 'stats.json'),
    `${JSON.stringify(buildStats(measures), null, 2)}\n`,
  )
  return measures.length
}

function runFixture(): void {
  run('normalization.ts', {
    pipeline: 'split',
    env: {
      MT_SPLIT_BOOK: `md://${fixtureBook}`,
      MT_SPLIT_ROOT: `md://${fixtureOut}`,
    },
    timeout: 120_000,
  })
}

beforeAll(async () => {
  await clean(STATS_FILE, MAP_FILE, SPLIT_DIR, join(SAMPLE_DIR, '.mt'))
  run('normalization.ts', { pipeline: 'stats', timeout: 120_000 })
  run('normalization.ts', { pipeline: 'split', timeout: 120_000 })
  identityMap = await readFile(MAP_FILE, 'utf-8')

  await buildFixture()
  runFixture()
}, 240_000)

afterEach(({ task }) => {
  if (task.result?.state === 'fail') hasFailure = true
})

afterAll(async () => {
  if (fixtureRoot) await rm(fixtureRoot, { recursive: true, force: true })
  if (!hasFailure) await clean(STATS_FILE, MAP_FILE, SPLIT_DIR, join(SAMPLE_DIR, '.mt'))
})

describe('split', () => {
  it('keeps book2 whole: identity map, no split copies', () => {
    const map = parseMap(identityMap)
    expect(Object.keys(map)).toHaveLength(CHAPTER_COUNT)
    for (let n = 1; n <= CHAPTER_COUNT; n++) {
      expect(map[String(n)]).toEqual({ orig: n, part: 1, of: 1 })
    }
    expect(existsSync(SPLIT_DIR)).toBe(false)
  })

  it('reruns byte-identically', async () => {
    run('normalization.ts', { pipeline: 'split', timeout: 120_000 })
    expect(await readFile(MAP_FILE, 'utf-8')).toBe(identityMap)
    expect(existsSync(SPLIT_DIR)).toBe(false)
  })

  it('splits an oversized chapter and renumbers the whole book', async () => {
    const stats = JSON.parse(
      await readFile(join(fixtureOut, 'schema', 'stats.json'), 'utf-8'),
    ) as StatsArtifact
    expect(stats.oversize).toEqual([FIXTURE_ORIG])

    const entries = mappedEntries(
      parseMap(await readFile(join(fixtureOut, 'schema', 'chapter-map.json'), 'utf-8')),
    )
    const total = entries.length
    expect(entries.map((entry) => entry.id)).toEqual([...Array(total)].map((_, i) => i + 1))

    const byOrigin = groupByOrigin(entries)
    expect([...byOrigin.keys()].sort((left, right) => left - right)).toEqual(
      [...Array(CHAPTER_COUNT)].map((_, i) => i + 1),
    )

    const oversized = byOrigin.get(FIXTURE_ORIG) ?? []
    expect(oversized.length).toBeGreaterThanOrEqual(2)
    expect(oversized.map((entry) => entry.part)).toEqual(oversized.map((_, i) => i + 1))
    expect(oversized.every((entry) => entry.of === oversized.length)).toBe(true)

    // ids contiguous per source chapter, ascending with the source numbering
    let next = 1
    for (const origin of [...byOrigin.keys()].sort((left, right) => left - right)) {
      const parts = byOrigin.get(origin) ?? []
      expect(parts.map((entry) => entry.part)).toEqual(parts.map((_, i) => i + 1))
      expect(parts.every((entry) => entry.of === parts.length)).toBe(true)
      expect(parts.map((entry) => entry.id)).toEqual(parts.map((_, i) => next + i))
      next += parts.length
    }

    const files = (await readdir(join(fixtureOut, 'split'))).sort(
      (left, right) => Number(left.replace(/\D/g, '')) - Number(right.replace(/\D/g, '')),
    )
    expect(files).toEqual([...Array(total)].map((_, i) => `chapter${i + 1}.md`))
    for (const entry of entries) {
      const markdown = await readFile(join(fixtureOut, 'split', `chapter${entry.id}.md`), 'utf-8')
      expect(chapterNumberOf(markdown, 0)).toBe(entry.id)
    }

    // the fixture run must not touch the real sample artefacts
    expect(await readFile(MAP_FILE, 'utf-8')).toBe(identityMap)
  })

  it('reruns a split fixture byte-identically', async () => {
    const before = await snapshot(fixtureOut)
    runFixture()
    expect(await snapshot(fixtureOut)).toEqual(before)
  })
})
