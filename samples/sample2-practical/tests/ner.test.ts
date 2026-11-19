import { readFile, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import {
  type ChapterEntities,
  type EntitiesArtifact,
  type ProjectedEntity,
  entityKind,
} from '@mt/tools'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { MOCK_NER_HALLUCINATION, MOCK_NER_NAMES } from '../lib/mock-ner.js'
import { CHAPTERS, SAMPLE_DIR, clean, run } from './helpers.js'

const SCHEMA_DIR = join(CHAPTERS, 'schema')
const ENTITIES = join(SCHEMA_DIR, 'entities.json')
const BOOK_DIR = join(SAMPLE_DIR, '..', '..', 'books', 'book2')
const CHAPTER_COUNT = 21
/** Free-tier request budget of the NER stage (see docs/roadmap.md §Request budget). */
const MAX_CALLS = 8

const CHAPTER_FILE = /^chapter(\d+)\.entities\.json$/

let hasFailure = false
let output = ''
let artifact: EntitiesArtifact
let chapterEntities: ChapterEntities[] = []
let chapterFiles: string[] = []

async function cleanEntities(): Promise<void> {
  const names = await readdir(SCHEMA_DIR).catch(() => [] as string[])
  await Promise.all(
    names
      .filter((name) => name === 'entities.json' || CHAPTER_FILE.test(name))
      .map((name) => rm(join(SCHEMA_DIR, name), { force: true })),
  )
}

function chapterNumberOfFile(name: string): number {
  return Number(CHAPTER_FILE.exec(name)?.[1] ?? 0)
}

async function readChapterEntities(names: readonly string[]): Promise<ChapterEntities[]> {
  return Promise.all(
    [...names]
      .sort((left, right) => chapterNumberOfFile(left) - chapterNumberOfFile(right))
      .map(
        async (name) =>
          JSON.parse(await readFile(join(SCHEMA_DIR, name), 'utf-8')) as ChapterEntities,
      ),
  )
}

/** Byte snapshot of every NER artefact (a rerun must reproduce it exactly). */
async function snapshot(): Promise<Record<string, string>> {
  const names = (await readdir(SCHEMA_DIR))
    .filter((name) => name === 'entities.json' || CHAPTER_FILE.test(name))
    .sort()
  const files: Record<string, string> = {}
  for (const name of names) files[name] = await readFile(join(SCHEMA_DIR, name), 'utf-8')
  return files
}

beforeAll(async () => {
  await cleanEntities()
  await clean(join(SAMPLE_DIR, '.mt'))
  output = run('preparation.ts', { pipeline: 'ner', timeout: 180_000 })
  artifact = JSON.parse(await readFile(ENTITIES, 'utf-8')) as EntitiesArtifact
  chapterFiles = (await readdir(SCHEMA_DIR)).filter((name) => CHAPTER_FILE.test(name))
  chapterEntities = await readChapterEntities(chapterFiles)
}, 180_000)

afterEach(({ task }) => {
  if (task.result?.state === 'fail') hasFailure = true
})

afterAll(async () => {
  if (!hasFailure) await cleanEntities()
})

describe('entity kinds', () => {
  it('maps glossary types to NER kinds without a core type change', () => {
    expect(entityKind('character')).toBe('character')
    expect(entityKind('place')).toBe('place')
    expect(entityKind('item')).toBe('asset')
    expect(entityKind('skill')).toBe('other')
    expect(entityKind('term', 'A shipping company of the bay.')).toBe('organisation')
    expect(entityKind('term', 'The wreck of the Pelargic.')).toBe('other')
  })
})

describe('ner', () => {
  it('keeps the grounded names and drops the hallucinated one (R3)', () => {
    const emitted = new Set(artifact.entities.map((entity) => entity.name))
    const proposed = [...MOCK_NER_NAMES, MOCK_NER_HALLUCINATION]
    expect(proposed.filter((name) => emitted.has(name))).toEqual(MOCK_NER_NAMES)
    expect(emitted.has(MOCK_NER_HALLUCINATION)).toBe(false)
  })

  it('grounds every entity in at least one chapter', async () => {
    const names = (await readdir(BOOK_DIR))
      .filter((name) => /^chapter-\d+\.en\.md$/.test(name))
      .sort()
    const corpus = (
      await Promise.all(names.map((name) => readFile(join(BOOK_DIR, name), 'utf-8')))
    ).join('\n')
    for (const entity of artifact.entities) {
      expect(corpus.includes(entity.name), entity.name).toBe(true)
      expect(entity.count).toBeGreaterThanOrEqual(1)
      expect(entity.chapters.length).toBeGreaterThan(0)
      expect(entity.firstChapter).toBe(Math.min(...entity.chapters))
    }
  })

  it('orders the book list by kind, then count desc, then name', () => {
    expect(artifact.version).toBe(1)
    const rank = ['character', 'place', 'organisation', 'asset', 'other']
    for (const entity of artifact.entities) {
      expect(rank).toContain(entity.kind)
      expect(Array.isArray(entity.aliases)).toBe(true)
      expect(typeof entity.description).toBe('string')
    }
    for (let index = 1; index < artifact.entities.length; index++) {
      const prev = artifact.entities[index - 1] as ProjectedEntity
      const cur = artifact.entities[index] as ProjectedEntity
      const kindOrder = rank.indexOf(prev.kind) - rank.indexOf(cur.kind)
      const byCount = prev.count - cur.count
      const byName = prev.name < cur.name ? -1 : prev.name > cur.name ? 1 : 0
      expect(
        kindOrder < 0 || (kindOrder === 0 && (byCount > 0 || (byCount === 0 && byName <= 0))),
      ).toBe(true)
    }
  })

  it('writes 21 per-chapter files whose mentions are exactly the book list', () => {
    expect(chapterFiles).toHaveLength(CHAPTER_COUNT)
    expect(chapterEntities.map((chapter) => chapter.n)).toEqual(
      Array.from({ length: CHAPTER_COUNT }, (_, index) => index + 1),
    )

    const byId = new Map(artifact.entities.map((entity) => [entity.id, entity]))
    for (const chapter of chapterEntities) {
      for (const entity of chapter.entities) {
        const book = byId.get(entity.id)
        expect(book, `${chapter.n}:${entity.id}`).toBeDefined()
        expect(entity.name).toBe(book?.name)
        expect(entity.kind).toBe(book?.kind)
        expect(entity.count).toBeGreaterThanOrEqual(1)
      }
    }

    const union = new Set(chapterEntities.flatMap((chapter) => chapter.entities.map((e) => e.id)))
    expect([...union].sort()).toEqual([...byId.keys()].sort())
  })

  it('sums the chapter mentions into the book count', () => {
    for (const entity of artifact.entities) {
      const total = chapterEntities.reduce(
        (sum, chapter) =>
          sum + (chapter.entities.find((mention) => mention.id === entity.id)?.count ?? 0),
        0,
      )
      expect(total, entity.name).toBe(entity.count)
    }
  })

  it('spends at most 8 LLM calls for the whole book', () => {
    const logged = /ner entities=(\d+) dropped=(\d+) calls=(\d+)/.exec(output)
    expect(logged, 'the ner log line is missing').not.toBeNull()
    const calls = Number(logged?.[3])
    expect(calls).toBeGreaterThan(0)
    expect(calls).toBeLessThanOrEqual(MAX_CALLS)
  })

  it('reruns byte-identically', async () => {
    const before = await snapshot()
    run('preparation.ts', { pipeline: 'ner', timeout: 180_000 })
    expect(await snapshot()).toEqual(before)
  })
})
