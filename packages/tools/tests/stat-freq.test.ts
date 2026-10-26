import { readFile, readdir, rm } from 'node:fs/promises'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getVariable } from '@mt/core'
import type { ToolContext } from '@mt/core'
import { describe, expect, it } from 'vitest'

import {
  buildStatFreqReport,
  defineStatFreq,
  splitStatSentences,
  statFreq,
  tokenizeWords,
} from '../src/normalization/stat-freq.js'
import type { StatFreqReport } from '../src/normalization/stat-freq.js'

const CTX = {} as ToolContext

const EN = 'The cat sat on the mat. The cat sat on the mat. Dogs bark loudly.'
const RU = 'Кот сидел на ковре. Кот сидел на ковре. Собака лаяла громко.'

describe('splitStatSentences', () => {
  it('splits on terminal punctuation', () => {
    expect(splitStatSentences('One. Two! Three?')).toEqual(['One.', 'Two!', 'Three?'])
  })

  it('splits on an ellipsis and keeps the last fragment', () => {
    expect(splitStatSentences('Wait… What now')).toEqual(['Wait…', 'What now'])
  })

  it('does not split after a known abbreviation', () => {
    expect(splitStatSentences('Pi is 3.14, e.g. 2.5x. Done.')).toEqual([
      'Pi is 3.14, e.g. 2.5x.',
      'Done.',
    ])
  })
})

describe('tokenizeWords', () => {
  it('lowercases and keeps apostrophes inside words', () => {
    expect(tokenizeWords("Don't stop The Keeper's sword")).toEqual([
      "don't",
      'stop',
      'the',
      "keeper's",
      'sword',
    ])
  })

  it('handles cyrillic and digits', () => {
    expect(tokenizeWords('Кот 2 раза')).toEqual(['кот', '2', 'раза'])
  })
})

describe('buildStatFreqReport', () => {
  const report = buildStatFreqReport([EN])

  it('counts every token and its distinct forms', () => {
    expect(report.totalWords).toBe(15)
    expect(report.uniqueWords).toBe(8)
  })

  it('ranks words by count, then alphabetically, and drops stopwords', () => {
    expect(report.words).toEqual([
      { word: 'cat', count: 2, share: 0.133333 },
      { word: 'mat', count: 2, share: 0.133333 },
      { word: 'sat', count: 2, share: 0.133333 },
      { word: 'bark', count: 1, share: 0.066667 },
      { word: 'dogs', count: 1, share: 0.066667 },
      { word: 'loudly', count: 1, share: 0.066667 },
    ])
    expect(report.words.some((w) => w.word === 'the')).toBe(false)
    expect(report.words.some((w) => w.word === 'on')).toBe(false)
  })

  it('lists repeated sentences only', () => {
    expect(report.sentences).toEqual([{ sentence: 'The cat sat on the mat.', count: 2 }])
  })

  it('builds 2..3 word n-grams without stopwords inside', () => {
    expect(report.ngrams).toEqual([
      { ngram: 'cat sat', count: 2 },
      { ngram: 'bark loudly', count: 1 },
      { ngram: 'dogs bark', count: 1 },
      { ngram: 'dogs bark loudly', count: 1 },
    ])
  })

  it('merges words and n-grams into a single top ranking', () => {
    expect(report.top.slice(0, 4)).toEqual([
      { term: 'cat', count: 2, kind: 'word' },
      { term: 'mat', count: 2, kind: 'word' },
      { term: 'sat', count: 2, kind: 'word' },
      { term: 'cat sat', count: 2, kind: 'ngram' },
    ])
    expect(report.top.every((entry) => entry.kind === 'word' || entry.kind === 'ngram')).toBe(true)
  })

  it('analyses russian text', () => {
    const ru = buildStatFreqReport([RU])
    expect(ru.totalWords).toBe(11)
    expect(ru.uniqueWords).toBe(7)
    expect(ru.words.map((w) => w.word)).toEqual([
      'ковре',
      'кот',
      'сидел',
      'громко',
      'лаяла',
      'собака',
    ])
    expect(ru.sentences).toEqual([{ sentence: 'Кот сидел на ковре.', count: 2 }])
    expect(ru.ngrams[0]).toEqual({ ngram: 'кот сидел', count: 2 })
  })

  it('filters custom stopwords', () => {
    const custom = buildStatFreqReport([EN], { stopwords: ['cat'] })
    expect(custom.words.some((w) => w.word === 'cat')).toBe(false)
    expect(custom.ngrams.some((n) => n.ngram === 'cat sat')).toBe(false)
    expect(custom.totalWords).toBe(15)
  })

  it('ignores tokens shorter than minWordLen', () => {
    const long = buildStatFreqReport([EN], { minWordLen: 4 })
    expect(long.totalWords).toBe(3)
    expect(long.words.map((w) => w.word)).toEqual(['bark', 'dogs', 'loudly'])
  })

  it('limits the n-gram size', () => {
    const bigrams = buildStatFreqReport([EN], { maxNgram: 2 })
    expect(bigrams.ngrams.map((n) => n.ngram)).toEqual(['cat sat', 'bark loudly', 'dogs bark'])
  })

  it('caps every list at topK', () => {
    const capped = buildStatFreqReport([EN], { topK: 2 })
    expect(capped.words).toHaveLength(2)
    expect(capped.ngrams).toHaveLength(2)
    expect(capped.sentences).toHaveLength(1)
    expect(capped.top).toHaveLength(2)
  })

  it('is deterministic', () => {
    expect(JSON.stringify(buildStatFreqReport([EN, RU]))).toBe(
      JSON.stringify(buildStatFreqReport([EN, RU])),
    )
  })
})

describe('statFreq tool', () => {
  it('stores the report in meta and keeps the item untouched', async () => {
    const out = await statFreq.invoke(
      { id: 'ex-test', variables: [], item: EN, meta: { chapterId: 'c1' } },
      CTX,
    )
    expect(out.item).toBe(EN)
    expect(out.meta.chapterId).toBe('c1')
    const report = getVariable(out, 'statFreq') as StatFreqReport
    expect(report.totalWords).toBe(15)
  })

  it('aggregates a batched corpus and keeps the cardinality', async () => {
    const items = [EN, RU]
    const out = await statFreq.invoke(
      { id: 'ex-test', variables: [], item: items, items, meta: {} },
      CTX,
    )
    expect(out.items).toEqual(items)
    const report = getVariable(out, 'statFreq') as StatFreqReport
    expect(report.totalWords).toBe(26)
    expect(report.uniqueWords).toBe(15)
  })

  it('writes the report to a file atomically', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mt-stat-freq-'))
    try {
      const outFile = join(dir, 'nested', 'stat.json')
      const tool = defineStatFreq({ outFile })
      const out = await tool.invoke({ id: 'ex-test', variables: [], item: EN, meta: {} }, CTX)
      const written = JSON.parse(await readFile(outFile, 'utf-8'))
      expect(written).toEqual(getVariable(out, 'statFreq'))
      const entries = await readdir(join(dir, 'nested'))
      expect(entries.filter((e) => e.includes('.tmp.'))).toEqual([])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
