import { buildStatFreqReport } from '@mt/tools'
import { describe, expect, it } from 'vitest'
import {
  VOCAB_MAX_DF,
  VOCAB_MAX_NGRAM,
  VOCAB_MIN_COUNT,
  type VocabChapter,
  type VocabTerm,
  buildVocabulary,
  buildVocabularyReport,
  classifyTerm,
  stopwordSet,
} from './vocabulary.js'

const CHAPTERS: VocabChapter[] = [
  {
    n: 1,
    text:
      'Arin met Bren at Marrow Bay. Later Arin saw Bren near Marrow Bay. ' +
      'Arin called Bren from Marrow Bay. The keeper watched.',
  },
  {
    n: 2,
    text:
      'Arin met Bren at Marrow Bay. Later Arin saw Bren near Marrow Bay. ' +
      'Arin called Bren from Marrow Bay. The keeper watched.',
  },
]

function bookReport() {
  return buildStatFreqReport(
    CHAPTERS.map((chapter) => chapter.text),
    { maxNgram: VOCAB_MAX_NGRAM, minWordLen: 3, topK: 100_000 },
  )
}

function byTerm(terms: readonly VocabTerm[]): Map<string, VocabTerm> {
  return new Map(terms.map((term) => [term.term, term]))
}

describe('classifyTerm', () => {
  it('classifies capitalised terms as proper regardless of size', () => {
    expect(classifyTerm(1, 5, 2, 0.9)).toBe('proper')
    expect(classifyTerm(2, 5, 2, 0.8)).toBe('proper')
  })

  it('classifies rare repeated unigrams only inside the count and df window', () => {
    expect(classifyTerm(1, 3, 1, 0)).toBe('rare-repeat')
    expect(classifyTerm(1, 12, VOCAB_MAX_DF, 0)).toBe('rare-repeat')
    expect(classifyTerm(1, 2, 1, 0)).toBeUndefined()
    expect(classifyTerm(1, 13, 1, 0)).toBeUndefined()
    expect(classifyTerm(1, 5, VOCAB_MAX_DF + 1, 0)).toBeUndefined()
  })

  it('classifies repeated multi-word terms as phrases', () => {
    expect(classifyTerm(2, 3, 2, 0)).toBe('phrase')
    expect(classifyTerm(3, 4, 2, 0)).toBe('phrase')
    expect(classifyTerm(2, 2, 2, 0)).toBeUndefined()
    expect(classifyTerm(2, 4, 1, 0)).toBeUndefined()
  })
})

describe('stopwordSet', () => {
  it('detects the counter stopwords without copying a list', () => {
    const stopwords = stopwordSet(['the', 'and', 'Arin'])
    expect(stopwords.has('the')).toBe(true)
    expect(stopwords.has('and')).toBe(true)
    expect(stopwords.has('arin')).toBe(false)
  })

  it('returns an empty set for no tokens', () => {
    expect(stopwordSet([]).size).toBe(0)
  })
})

describe('buildVocabularyReport', () => {
  it('marks repeated capitalised names as proper nouns with chapters and df', () => {
    const { artifact } = buildVocabularyReport(bookReport(), CHAPTERS)
    const terms = byTerm(artifact.terms)

    for (const name of ['arin', 'bren']) {
      expect(terms.get(name)).toMatchObject({
        n: 1,
        count: 6,
        df: 2,
        chapters: [1, 2],
        capRatio: 1,
        kind: 'proper',
      })
    }
    expect(artifact.terms.map((term) => term.term)).toEqual(['arin', 'bay', 'bren', 'marrow'])
  })

  it('drops terms the classifier cannot place and phrases of top unigrams', () => {
    const { dropped } = buildVocabularyReport(bookReport(), CHAPTERS)
    expect(dropped.unclassified).toBeGreaterThan(0)
    expect(dropped.topUnigram).toBeGreaterThan(0)
  })

  it('emits the declared artefact parameters and ordering', () => {
    const { artifact } = buildVocabularyReport(bookReport(), CHAPTERS)
    expect(artifact.version).toBe(1)
    expect(artifact.params).toEqual({
      maxNgram: VOCAB_MAX_NGRAM,
      minCount: VOCAB_MIN_COUNT,
      maxDf: VOCAB_MAX_DF,
    })
    for (let index = 1; index < artifact.terms.length; index++) {
      const prev = artifact.terms[index - 1] as VocabTerm
      const cur = artifact.terms[index] as VocabTerm
      expect(prev.kind).toBe('proper')
      expect(cur.kind).toBe('proper')
      expect(prev.count).toBeGreaterThanOrEqual(cur.count)
      if (prev.count === cur.count) expect(prev.term < cur.term).toBe(true)
    }
  })

  it('is deterministic and buildVocabulary returns the same artefact', () => {
    const book = bookReport()
    const first = buildVocabularyReport(book, CHAPTERS)
    const second = buildVocabularyReport(book, CHAPTERS)
    expect(second).toEqual(first)
    expect(buildVocabulary(book, CHAPTERS)).toEqual(first.artifact)
  })

  it('orders chapters before counting, so input order does not matter', () => {
    const book = bookReport()
    const ordered = buildVocabularyReport(book, CHAPTERS)
    const reversed = buildVocabularyReport(book, [...CHAPTERS].reverse())
    expect(reversed).toEqual(ordered)
  })
})
