import { category, defineTool, getVariable, tool, withItem } from '@mt/core'
import type { Exchange } from '@mt/core'
import { compactArrays } from '../core/json-format.js'
import { appendMdOutput } from '../core/md-outputs.js'
import { chapterNumberOf } from './glossary-extractor.js'
import {
  type StatFreqReport,
  buildStatFreqReport,
  cmpTerm,
  splitStatSentences,
} from './stat-freq.js'

/**
 * Statistical vocabulary (CPU only, no LLM).
 *
 * The book-wide candidate ranking comes from the `stat-freq` tool; per-chapter counts come from
 * its exported pure `buildStatFreqReport`, so a term gets `chapters[]` and a document frequency.
 * This glue adds what `StatFreqNgram` lacks — `df`, `capRatio` (the proper-noun signal) and the
 * noise filter of roadmap risk R4 — and emits one deterministic `schema/vocabulary.json`.
 */

/** Largest n-gram of the stage (`STAT_FREQ_MAX_NGRAM` defaults to 3, the stage needs 4). */
export const VOCAB_MAX_NGRAM = 4
/** Tokens shorter than this are ignored by the counter. */
export const VOCAB_MIN_WORD_LEN = 3
/** Entries per ranked list of the book report. */
export const VOCAB_TOP_K = 2000
/** A candidate needs at least this many book-wide occurrences. */
export const VOCAB_MIN_COUNT = 2
/** Highest document frequency a `rare-repeat` unigram may have. */
export const VOCAB_MAX_DF = 3

const VOCAB_VERSION = 1
/** A term is a proper noun when this share of its mid-sentence mentions is capitalised. */
const PROPER_MIN_RATIO = 0.8
const RARE_MIN_COUNT = 3
const RARE_MAX_COUNT = 12
const PHRASE_MIN_COUNT = 3
const PHRASE_MIN_DF = 2
/** R4: a phrase made only of this many most frequent unigrams says nothing new. */
const NOISE_TOP_UNIGRAMS = 100
/** Per-chapter lists must be complete: `df` counts chapters, not a truncated top-K. */
const CHAPTER_TOP_K = 1_000_000

export type VocabKind = 'proper' | 'rare-repeat' | 'phrase'

/** Emitted order of the kinds. */
const KIND_ORDER: readonly VocabKind[] = ['proper', 'rare-repeat', 'phrase']

export interface VocabTerm {
  term: string
  /** Word count of the term (1..`VOCAB_MAX_NGRAM`). */
  n: number
  /** Occurrences in the whole book. */
  count: number
  /** Document frequency: chapters the term occurs in. */
  df: number
  /** Chapters containing the term, ascending. */
  chapters: number[]
  /** Share of mid-sentence occurrences that are capitalised (0..1). */
  capRatio: number
  kind: VocabKind
}

export interface VocabularyParams {
  maxNgram: number
  minCount: number
  maxDf: number
}

/** `chapters/schema/vocabulary.json` (stable key order, no timestamps). */
export interface VocabularyArtifact {
  version: number
  params: VocabularyParams
  terms: VocabTerm[]
}

/** One chapter of the analysed book. */
export interface VocabChapter {
  n: number
  text: string
}

/** Terms dropped by each noise rule (diagnostics for the run log and the roadmap notes). */
export interface VocabularyDrops {
  stopword: number
  topUnigram: number
  unclassified: number
}

export interface VocabularyReport {
  artifact: VocabularyArtifact
  dropped: VocabularyDrops
}

/** Round to four decimals so a rerun serializes byte-identically. */
function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000
}

/** Word count of a space-joined term. */
function termSize(term: string): number {
  return term.split(' ').length
}

/** Word part before an apostrophe (`i'm` -> `i`), so its stopword form is recognisable. */
function stem(token: string): string {
  return token.replace(/['’].*$/u, '')
}

/**
 * The repo stopword list, probed through the counter itself: a word `buildStatFreqReport`
 * refuses to rank is a stopword. No list is copied here — `stat-freq.ts` stays the single source.
 */
export function stopwordSet(tokens: readonly string[]): Set<string> {
  const unique = [...new Set(tokens.map((token) => token.toLowerCase()).filter((t) => t !== ''))]
  if (unique.length === 0) return new Set()
  const report = buildStatFreqReport(unique, {
    maxNgram: 2,
    minWordLen: 1,
    topK: unique.length + 1,
  })
  const ranked = new Set(report.words.map((entry) => entry.word))
  return new Set(unique.filter((token) => !ranked.has(token)))
}

function isStopEdge(token: string, stopwords: ReadonlySet<string>): boolean {
  const lower = token.toLowerCase()
  return stopwords.has(lower) || stopwords.has(stem(lower))
}

/** Case-preserving unicode word token (same shape as the counter's, case kept). */
const WORD_TOKEN = /[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu

interface CapTally {
  /** Mid-sentence occurrences with a capitalised first letter. */
  cap: number
  /** All mid-sentence occurrences. */
  mid: number
}

/**
 * One case-preserving pass over a chapter: for every candidate occurrence not at a sentence
 * start, count it and whether it is capitalised. Sentence-initial occurrences are excluded from
 * both sides — a sentence always starts with a capital, so they carry no proper-noun signal.
 */
function tallyCapitalisation(
  text: string,
  candidates: ReadonlySet<string>,
  tally: Map<string, CapTally>,
): void {
  for (const sentence of splitStatSentences(text)) {
    const tokens = [...sentence.matchAll(WORD_TOKEN)]
      .map((match) => match[0])
      .filter((token) => token.length >= VOCAB_MIN_WORD_LEN)

    for (let i = 0; i < tokens.length; i++) {
      const first = tokens[i]
      if (first === undefined) continue
      const capitalised = /^\p{Lu}/u.test(first)
      const words: string[] = []
      for (let n = 1; n <= VOCAB_MAX_NGRAM; n++) {
        const token = tokens[i + n - 1]
        if (token === undefined) break
        words.push(token.toLowerCase())
        if (i === 0) continue
        const term = words.join(' ')
        if (!candidates.has(term)) continue
        const row = tally.get(term) ?? { cap: 0, mid: 0 }
        row.mid += 1
        if (capitalised) row.cap += 1
        tally.set(term, row)
      }
    }
  }
}

/** Per-chapter term counts from the counter's own report (words + n-grams). */
function termCounts(report: StatFreqReport): Map<string, number> {
  const counts = new Map<string, number>()
  for (const word of report.words) counts.set(word.word, word.count)
  for (const ngram of report.ngrams) counts.set(ngram.ngram, ngram.count)
  return counts
}

/** Kind of a candidate, or `undefined` when it is ordinary prose and must be dropped. */
export function classifyTerm(
  n: number,
  count: number,
  df: number,
  capRatio: number,
): VocabKind | undefined {
  if (capRatio >= PROPER_MIN_RATIO) return 'proper'
  if (n === 1 && count >= RARE_MIN_COUNT && count <= RARE_MAX_COUNT && df <= VOCAB_MAX_DF) {
    return 'rare-repeat'
  }
  if (n >= 2 && count >= PHRASE_MIN_COUNT && df >= PHRASE_MIN_DF) return 'phrase'
  return undefined
}

/**
 * Builds the vocabulary artefact and the per-rule drop counts.
 *
 * `book` is the whole-book frequency report; `chapters` are the raw chapter texts. Counting is
 * delegated to `buildStatFreqReport` on both levels; only `capRatio` needs its own case-preserving
 * pass, because the counter lowercases its tokens.
 */
export function buildVocabularyReport(
  book: StatFreqReport,
  chapters: readonly VocabChapter[],
): VocabularyReport {
  const ordered = [...chapters].sort((left, right) => left.n - right.n)
  const chapterOptions = {
    maxNgram: VOCAB_MAX_NGRAM,
    minWordLen: VOCAB_MIN_WORD_LEN,
    topK: CHAPTER_TOP_K,
  }
  const perChapter = ordered.map(({ n, text }) => ({
    n,
    counts: termCounts(buildStatFreqReport([text], chapterOptions)),
  }))

  const candidates = new Map<string, number>()
  for (const word of book.words) {
    if (word.count >= VOCAB_MIN_COUNT) candidates.set(word.word, word.count)
  }
  for (const ngram of book.ngrams) {
    if (ngram.count >= VOCAB_MIN_COUNT) candidates.set(ngram.ngram, ngram.count)
  }

  const topUnigrams = new Set(book.words.slice(0, NOISE_TOP_UNIGRAMS).map((entry) => entry.word))

  const edges: string[] = []
  for (const term of candidates.keys()) {
    const tokens = term.split(' ')
    const first = tokens[0]
    const last = tokens.at(-1)
    if (first !== undefined) edges.push(first, stem(first))
    if (last !== undefined) edges.push(last, stem(last))
  }
  const stopwords = stopwordSet(edges)
  const candidateSet = new Set(candidates.keys())

  const tally = new Map<string, CapTally>()
  for (const { text } of ordered) tallyCapitalisation(text, candidateSet, tally)

  const dropped: VocabularyDrops = { stopword: 0, topUnigram: 0, unclassified: 0 }
  const terms: VocabTerm[] = []

  for (const [term, count] of candidates) {
    const n = termSize(term)
    const tokens = term.split(' ')
    const first = tokens[0] ?? term
    const last = tokens.at(-1) ?? term

    if (isStopEdge(first, stopwords) || isStopEdge(last, stopwords)) {
      dropped.stopword += 1
      continue
    }
    if (n >= 2 && tokens.every((token) => topUnigrams.has(token))) {
      dropped.topUnigram += 1
      continue
    }

    const present = perChapter.filter((row) => (row.counts.get(term) ?? 0) > 0)
    const df = present.length
    const cap = tally.get(term)
    const capRatio = cap && cap.mid > 0 ? round4(cap.cap / cap.mid) : 0
    const kind = classifyTerm(n, count, df, capRatio)
    if (kind === undefined) {
      dropped.unclassified += 1
      continue
    }

    terms.push({
      term,
      n,
      count,
      df,
      chapters: present.map((row) => row.n),
      capRatio,
      kind,
    })
  }

  terms.sort(
    (left, right) =>
      KIND_ORDER.indexOf(left.kind) - KIND_ORDER.indexOf(right.kind) ||
      right.count - left.count ||
      cmpTerm(left.term, right.term),
  )

  return {
    artifact: {
      version: VOCAB_VERSION,
      params: {
        maxNgram: VOCAB_MAX_NGRAM,
        minCount: VOCAB_MIN_COUNT,
        maxDf: VOCAB_MAX_DF,
      },
      terms,
    },
    dropped,
  }
}

/** The artefact alone (see {@link buildVocabularyReport} for the drop counts). */
export function buildVocabulary(
  book: StatFreqReport,
  chapters: readonly VocabChapter[],
): VocabularyArtifact {
  return buildVocabularyReport(book, chapters).artifact
}

/**
 * Aggregation stage: reads the `statFreq` book report, counts every chapter and emits
 * `schema/vocabulary.json`. No LLM, no network.
 */
export const writeVocabulary = defineTool<unknown, unknown>({
  name: 'write-vocabulary',
  version: '1.0.0',
  description:
    'Emits schema/vocabulary.json (4/3/2/1-grams with chapters, df and capRatio) from the `statFreq` report and the batched chapters.',
  annotations: [
    tool('TL275', {
      name: 'write-vocabulary',
      description:
        'Ranks proper nouns, rare repeats and phrases with chapter frequencies and emits schema/vocabulary.json.',
      refs: [],
    }),
    category(['statistics']),
  ],
  async invoke(env: Exchange<unknown>, ctx) {
    const report = getVariable<StatFreqReport>(env, 'statFreq')
    if (!report) {
      throw new Error(
        'write-vocabulary: the `statFreq` variable is missing (run the stat-freq tool first)',
      )
    }
    const texts = (env.items ?? (Array.isArray(env.item) ? env.item : [env.item]))
      .flat()
      .filter((item): item is string => typeof item === 'string')
    const chapters = texts.map((text, index) => ({
      n: chapterNumberOf(text, index + 1),
      text,
    }))
    const { artifact, dropped } = buildVocabularyReport(report, chapters)
    const phrases = artifact.terms.filter((term) => term.kind === 'phrase').length
    const proper = artifact.terms.filter((term) => term.kind === 'proper').length
    const unigrams = artifact.terms.filter((term) => term.n === 1).length
    ctx.run.logger.info(
      `vocab terms=${artifact.terms.length} phrases=${phrases} proper=${proper} unigrams=${unigrams}`,
    )
    ctx.run.logger.debug(
      `vocab dropped stopword=${dropped.stopword} topUnigram=${dropped.topUnigram} unclassified=${dropped.unclassified}`,
    )

    return appendMdOutput(withItem(env, ''), {
      name: 'vocabulary',
      subdir: '',
      filename: 'vocabulary.json',
      content: `${compactArrays(JSON.stringify(artifact, null, 2))}\n`,
    })
  },
})
