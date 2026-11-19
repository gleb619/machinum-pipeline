import { mkdir, mkdtemp, readFile, readdir, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'
import { type StatsArtifact, bodyCharsOf } from '@mt/bookkit'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { SAMPLE_DIR, run, writeFileAt } from './helpers.js'

const BOOK_DIR = resolve(SAMPLE_DIR, '..', '..', 'books', 'book2')
const CHAPTER_COUNT = 21

let hasFailure = false
let projectRoot = ''
let statsFile = ''
let firstRun = ''

/**
 * A throwaway project root with the same `@book2` / `@schema` aliases as the sample, so the
 * stats run cannot read or write the shared `chapters/` tree (which may hold a finished book).
 */
async function buildProject(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'mt-stats-'))
  await mkdir(join(root, 'chapters', 'schema'), { recursive: true })
  await symlink(join(SAMPLE_DIR, 'node_modules'), join(root, 'node_modules'), 'dir')
  await writeFileAt(
    join(root, 'mt.json'),
    `${JSON.stringify(
      {
        project: { name: 'stats-test' },
        uris: {
          book2: `md://${BOOK_DIR}`,
          schema: `md://${join(root, 'chapters', 'schema')}`,
        },
        settings: { 'llm.tool': 'mock' },
      },
      null,
      2,
    )}\n`,
  )
  return root
}

/** Files under `dir`, relative to it, for the "wrote nothing else" assertion. */
async function filesUnder(dir: string, base = dir): Promise<string[]> {
  const files: string[] = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) files.push(...(await filesUnder(path, base)))
    else files.push(relative(base, path))
  }
  return files.sort()
}

beforeAll(async () => {
  projectRoot = await buildProject()
  statsFile = join(projectRoot, 'chapters', 'schema', 'stats.json')
  run('normalization.ts', { pipeline: 'stats', cwd: projectRoot, timeout: 120_000 })
  firstRun = await readFile(statsFile, 'utf-8')
}, 120_000)

afterEach(({ task }) => {
  if (task.result?.state === 'fail') hasFailure = true
})

afterAll(async () => {
  if (!hasFailure && projectRoot !== '') {
    await rm(projectRoot, { recursive: true, force: true })
  }
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
    run('normalization.ts', { pipeline: 'stats', cwd: projectRoot, timeout: 120_000 })
    expect(await readFile(statsFile, 'utf-8')).toBe(firstRun)
  })

  it('writes only chapters/schema/stats.json', async () => {
    expect(await filesUnder(join(projectRoot, 'chapters'))).toEqual(['schema/stats.json'])
  })
})
