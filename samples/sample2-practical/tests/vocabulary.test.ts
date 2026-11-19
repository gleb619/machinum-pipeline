import { existsSync } from 'node:fs'
import { readFile, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import {
  VOCAB_MAX_NGRAM,
  VOCAB_MIN_COUNT,
  VOCAB_MIN_WORD_LEN,
  VOCAB_TOP_K,
  type VocabKind,
  type VocabTerm,
  type VocabularyArtifact,
} from '@mt/tools'
import { buildStatFreqReport } from '@mt/tools'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { CHAPTERS, SAMPLE_DIR, clean, run } from './helpers.js'

const SCHEMA_DIR = join(CHAPTERS, 'schema')
const VOCAB_FILE = join(SCHEMA_DIR, 'vocabulary.json')
const BOOK_DIR = join(SAMPLE_DIR, '..', '..', 'books', 'book2')
const CHAPTER_COUNT = 21
const KIND_ORDER: readonly VocabKind[] = ['proper', 'rare-repeat', 'phrase']

/**
 * A backend that throws if it is ever used: the stage is CPU-only, so a closed router port can
 * only be reached if some code resolved a model or issued a call.
 */
const NO_LLM_ENV = {
  MT_LLM_TOOL: 'router',
  MT_LLM_MODEL: 'stub:free',
  MT_ROUTER_URL: 'http://127.0.0.1:1',
}

let hasFailure = false
let output = ''
let firstRun = ''
let artifact: VocabularyArtifact
let ruBefore: Record<string, string> = {}
let splitBefore: Record<string, string> = {}

function chapterNumber(name: string): number {
  return Number.parseInt(name.match(/^chapter-(\d+)\.en\.md$/)?.[1] ?? '0', 10)
}

/** Chapter texts in number order (the stage sees the same source). */
async function bookTexts(): Promise<string[]> {
  const names = (await readdir(BOOK_DIR))
    .filter((name) => /^chapter-\d+\.en\.md$/.test(name))
    .sort((left, right) => chapterNumber(left) - chapterNumber(right))
  return Promise.all(names.map((name) => readFile(join(BOOK_DIR, name), 'utf-8')))
}

/** Recursive text snapshot of a directory (a stage must not touch it). */
async function tree(dir: string): Promise<Record<string, string>> {
  const names = await readdir(dir, { recursive: true }).catch(() => [] as string[])
  const files: Record<string, string> = {}
  for (const name of names) {
    files[name] = await readFile(join(dir, name), 'utf-8').catch(() => '<dir>')
  }
  return files
}

function byTerm(terms: readonly VocabTerm[]): Map<string, VocabTerm> {
  return new Map(terms.map((term) => [term.term, term]))
}

beforeAll(async () => {
  await clean(VOCAB_FILE, join(SAMPLE_DIR, '.mt'))
  ruBefore = await tree(join(CHAPTERS, 'ru'))
  splitBefore = await tree(join(CHAPTERS, 'split'))
  output = run('preparation.ts', { pipeline: 'vocabulary', timeout: 180_000, env: NO_LLM_ENV })
  firstRun = await readFile(VOCAB_FILE, 'utf-8')
  artifact = JSON.parse(firstRun) as VocabularyArtifact
}, 180_000)

afterEach(({ task }) => {
  if (task.result?.state === 'fail') hasFailure = true
})

afterAll(async () => {
  if (!hasFailure) await clean(VOCAB_FILE)
})

describe('vocabulary', () => {
  it('runs without touching an LLM backend', () => {
    expect(output).toMatch(/vocab terms=\d+ phrases=\d+ proper=\d+ unigrams=\d+/)
    expect(output).not.toContain('backend=')
    expect(output).not.toMatch(/\[mock\]|\[router\]/)
  })

  it('emits the declared artefact shape', () => {
    expect(artifact.version).toBe(1)
    expect(artifact.params).toEqual({
      maxNgram: VOCAB_MAX_NGRAM,
      minCount: VOCAB_MIN_COUNT,
      maxDf: 3,
    })
    expect(artifact.params.maxNgram).toBe(4)
    expect(artifact.terms.length).toBeGreaterThan(0)
    expect(artifact.terms.some((term) => term.n === 4)).toBe(true)
  })

  it('gives every term chapters[], df and a bounded capRatio', () => {
    for (const term of artifact.terms) {
      expect(term.n).toBe(term.term.split(' ').length)
      expect(term.n).toBeGreaterThanOrEqual(1)
      expect(term.n).toBeLessThanOrEqual(VOCAB_MAX_NGRAM)
      expect(term.count).toBeGreaterThanOrEqual(VOCAB_MIN_COUNT)
      expect(term.df).toBe(term.chapters.length)
      expect(term.chapters.length).toBeGreaterThan(0)
      expect(term.chapters).toEqual([...term.chapters].sort((left, right) => left - right))
      expect(new Set(term.chapters).size).toBe(term.chapters.length)
      for (const n of term.chapters) expect(n).toBeGreaterThanOrEqual(1)
      for (const n of term.chapters) expect(n).toBeLessThanOrEqual(CHAPTER_COUNT)
      expect(term.capRatio).toBeGreaterThanOrEqual(0)
      expect(term.capRatio).toBeLessThanOrEqual(1)
      expect(KIND_ORDER).toContain(term.kind)
    }
  })

  it('derives chapters[] and count from the pure per-chapter counter', async () => {
    const inputs = await bookTexts()
    const perChapter = inputs.map((text) => {
      const report = buildStatFreqReport([text], {
        maxNgram: VOCAB_MAX_NGRAM,
        minWordLen: VOCAB_MIN_WORD_LEN,
        topK: 1_000_000,
      })
      const counts = new Map<string, number>()
      for (const word of report.words) counts.set(word.word, word.count)
      for (const ngram of report.ngrams) counts.set(ngram.ngram, ngram.count)
      return counts
    })

    for (const term of artifact.terms) {
      const present = perChapter
        .map((counts, index) => ((counts.get(term.term) ?? 0) > 0 ? index + 1 : 0))
        .filter((n) => n > 0)
      expect(term.chapters, term.term).toEqual(present)
      const total = perChapter.reduce((sum, counts) => sum + (counts.get(term.term) ?? 0), 0)
      expect(total, term.term).toBe(term.count)
    }
  })

  it('never starts or ends a term with a stopword of the repo list', () => {
    const edges = [
      ...new Set(
        artifact.terms.flatMap((term) => {
          const parts = term.term.split(' ')
          return [parts[0], parts.at(-1)]
        }),
      ),
    ].filter((edge): edge is string => edge !== undefined)
    const probe = buildStatFreqReport(edges, {
      maxNgram: 2,
      minWordLen: 1,
      topK: edges.length + 1,
    })
    const ranked = new Set(probe.words.map((word) => word.word))
    for (const term of artifact.terms) {
      const parts = term.term.split(' ')
      expect(ranked.has(parts[0] ?? ''), term.term).toBe(true)
      expect(ranked.has(parts.at(-1) ?? ''), term.term).toBe(true)
    }
  })

  it('drops phrases made only of the top-100 unigrams (R4)', async () => {
    const book = buildStatFreqReport(await bookTexts(), {
      maxNgram: VOCAB_MAX_NGRAM,
      minWordLen: VOCAB_MIN_WORD_LEN,
      topK: VOCAB_TOP_K,
    })
    const top = new Set(book.words.slice(0, 100).map((word) => word.word))
    for (const term of artifact.terms.filter((entry) => entry.n >= 2)) {
      expect(
        term.term.split(' ').every((word) => top.has(word)),
        term.term,
      ).toBe(false)
    }
  })

  it('marks the capitalised names of the corpus as proper', () => {
    const terms = byTerm(artifact.terms)
    for (const name of ['pelargic', 'fiona', 'nadia', 'marrow bay']) {
      expect(terms.get(name)?.kind, name).toBe('proper')
      expect(terms.get(name)?.capRatio, name).toBeGreaterThanOrEqual(0.8)
    }
  })

  it('orders by kind, then count desc, then code point', () => {
    for (let index = 1; index < artifact.terms.length; index++) {
      const prev = artifact.terms[index - 1] as VocabTerm
      const cur = artifact.terms[index] as VocabTerm
      const kindOrder = KIND_ORDER.indexOf(prev.kind) - KIND_ORDER.indexOf(cur.kind)
      const byCount = prev.count - cur.count
      expect(
        kindOrder < 0 ||
          (kindOrder === 0 && (byCount > 0 || (byCount === 0 && prev.term < cur.term))),
        `${prev.term} before ${cur.term}`,
      ).toBe(true)
    }
  })

  it('is byte-identical on a second run', async () => {
    run('preparation.ts', { pipeline: 'vocabulary', timeout: 180_000, env: NO_LLM_ENV })
    expect(await readFile(VOCAB_FILE, 'utf-8')).toBe(firstRun)
  })

  it('writes only chapters/schema/vocabulary.json', async () => {
    expect(existsSync(VOCAB_FILE)).toBe(true)
    expect(await tree(join(CHAPTERS, 'ru'))).toEqual(ruBefore)
    expect(await tree(join(CHAPTERS, 'split'))).toEqual(splitBefore)
  })
})
