import { dirname } from 'node:path'
import { defineTool } from '@mt/core'
import type { Envelope } from '@mt/core'
import { atomicWriteFile, ensureParentDir } from '../core/fs-write.js'

/**
 * Offline statistical frequency analyzer (T147).
 *
 * Tokenizes the text of an envelope (a single item or a batched corpus), counts word,
 * sentence and n-gram frequencies, filters stopwords and emits a ranked report in
 * `env.meta.statFreq` (optionally also as an atomic JSON file).
 *
 * No LLM, no network — pure counting, deterministic for the same input.
 */

/** One ranked word frequency (stopwords are never listed). */
export interface StatFreqWord {
  /** Lowercased token. */
  word: string
  /** Occurrences in the analysed text. */
  count: number
  /** `count / totalWords`, rounded to 6 decimals (0 when the text has no words). */
  share: number
}

/** One repeated sentence (listed when it occurs at least twice). */
export interface StatFreqSentence {
  /** Sentence text, whitespace-normalised. */
  sentence: string
  /** Occurrences in the analysed text. */
  count: number
}

/** One ranked n-gram (2..`maxNgram` words, no stopword inside). */
export interface StatFreqNgram {
  /** Space-joined lowercase words. */
  ngram: string
  /** Occurrences in the analysed text. */
  count: number
}

/** Kind of a `top` entry. */
export type StatFreqKind = 'word' | 'ngram'

/** One entry of the merged top-terms ranking. */
export interface StatFreqTopEntry {
  /** The term (a word or an n-gram). */
  term: string
  /** Occurrences in the analysed text. */
  count: number
  /** Which list the term comes from. */
  kind: StatFreqKind
}

/** Ranked frequency report for the analysed text. */
export interface StatFreqReport {
  /** Total tokens (stopwords included, tokens shorter than `minWordLen` excluded). */
  totalWords: number
  /** Distinct tokens (stopwords included, tokens shorter than `minWordLen` excluded). */
  uniqueWords: number
  /** Ranked non-stopword tokens, count desc then term asc. */
  words: StatFreqWord[]
  /** Repeated sentences (count >= 2), count desc then text asc. */
  sentences: StatFreqSentence[]
  /** Ranked n-grams, count desc then n-gram asc. */
  ngrams: StatFreqNgram[]
  /** Merged ranking of words and n-grams, count desc then kind then term asc. */
  top: StatFreqTopEntry[]
}

/** Options of {@link defineStatFreq}. */
export interface StatFreqOptions {
  /** Extra stopwords (lowercased) added to the built-in EN + RU list. */
  stopwords?: string[]
  /** Minimum token length (characters) to be counted. Default: 1. */
  minWordLen?: number
  /** Largest n-gram size in words (2..`maxNgram` are built). Default: 3. */
  maxNgram?: number
  /** Max entries per ranked list. Default: 500. */
  topK?: number
  /** When set, the report is also written there as JSON (atomic write). */
  outFile?: string
}

/** Built-in stopwords: English + Russian function words. */
const DEFAULT_STOPWORDS = new Set(
  // English
  (
    'a about above after again against all also am an and another any are as at back be because been before ' +
    'being below between both but by came can cannot come could did do does doing don down during each even ' +
    'every few for from further get got go went had has have having he her here hers herself him himself his ' +
    'how i if in into is it its itself just know knew let like made make many may me might more most much must ' +
    'my myself never new no nor not now of off on once one only or other others ought our ours ourselves out ' +
    'over own per perhaps said same say see shall she should since so some someone something still such take ' +
    'than that the their theirs them themselves then there these they thing things this those though through ' +
    'thus to too two under until up upon us use used very via was way we well were what when where whether which ' +
    'while who whom whose why will with without would yet you your yours yourself yourselves ' +
    // Russian
    'а без более больше будет будто бы был была были было быть в вам вас вдруг ведь во вот все всегда всего ' +
    'всех всю вы где да даже для до другой его ее ей ему если есть еще же за здесь и из или им иногда их к как ' +
    'какая какой когда конечно кто куда ли лучше между меня мне много может можно мой моя мы на над надо наконец ' +
    'нас не него нее ней нельзя нет ни нибудь никогда ним них ничего но ну о об один он она они опять от перед ' +
    'по под после потом потому почти при про раз разве с сам свое свою себя сейчас со совсем так такой там тебя ' +
    'тем теперь то тогда того тоже только том тот тут ты у уже хотя чего чем через что чтоб чтобы чуть эти этого ' +
    'этой этом этот я'
  ).split(' '),
)

/** Sentence boundary: terminal punctuation plus optional closing quotes and a space. */
const SENTENCE_END = /[.!?…]+["»')\]]*\s+/gu

/** The terminal punctuation (with closing quotes) of a sentence end. */
const PUNCTUATION = /^[.!?…]+["»')\]]*/

/** Words that end in a dot without ending the sentence. */
const ABBREVIATIONS = new Set([
  'mr',
  'mrs',
  'ms',
  'dr',
  'prof',
  'sr',
  'jr',
  'st',
  'vs',
  'etc',
  'e.g',
  'i.e',
  'fig',
  'vol',
  'no',
  'др',
  'см',
  'стр',
  'рис',
  'табл',
  'т.д',
  'т.п',
  'т.к',
])

/** Unicode word token: letters/digits, apostrophes kept inside a word. */
const WORD = /[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu

/** True when the text ends with a known abbreviation (so it is not a sentence end). */
function endsWithAbbreviation(text: string): boolean {
  const tail = text.trimEnd().split(/\s+/).pop()?.toLowerCase() ?? ''
  return ABBREVIATIONS.has(tail.replace(/\.$/, ''))
}

/**
 * Split text into sentences (regex, no dependencies).
 *
 * Terminal punctuation (`.` `!` `?` `…`) plus optional closing quotes ends a sentence;
 * known abbreviations (`Mr.`, `e.g.`, `т.д.`) do not.
 */
export function splitStatSentences(text: string): string[] {
  const out: string[] = []
  let last = 0
  SENTENCE_END.lastIndex = 0
  let match = SENTENCE_END.exec(text)
  while (match !== null) {
    const head = text.slice(last, match.index)
    const punct = PUNCTUATION.exec(match[0])?.[0] ?? ''
    if (!endsWithAbbreviation(head)) {
      out.push(`${head}${punct}`)
      last = match.index + punct.length
    }
    match = SENTENCE_END.exec(text)
  }
  out.push(text.slice(last))
  return out.map((s) => s.trim()).filter((s) => s.length > 0)
}

/** Lowercased word tokens of a text (unicode-aware). */
export function tokenizeWords(text: string): string[] {
  return (text.match(WORD) ?? []).map((w) => w.toLowerCase())
}

/** Whitespace-normalised sentence text, so repeats compare equal. */
function normalizeSentence(sentence: string): string {
  return sentence.replace(/\s+/g, ' ').trim()
}

/** Compare two terms by code point (locale independent, deterministic). */
export function cmpTerm(a: string, b: string): number {
  if (a === b) return 0
  return a < b ? -1 : 1
}

/** Rank a `[term, count]` pair: count desc, then term asc. */
function rankEntry(a: [string, number], b: [string, number]): number {
  if (a[1] !== b[1]) return b[1] - a[1]
  return cmpTerm(a[0], b[0])
}

/**
 * Count word / sentence / n-gram frequencies of the given texts.
 *
 * Pure: the same input always yields the same report.
 */
export function buildStatFreqReport(
  texts: string[],
  options: StatFreqOptions = {},
): StatFreqReport {
  const stopwords = new Set(DEFAULT_STOPWORDS)
  for (const word of options.stopwords ?? []) stopwords.add(word.toLowerCase())
  const minWordLen = Math.max(1, options.minWordLen ?? 1)
  const maxNgram = Math.max(2, options.maxNgram ?? 3)
  const topK = Math.max(1, options.topK ?? 500)

  const wordCounts = new Map<string, number>()
  const ngramCounts = new Map<string, number>()
  const sentenceCounts = new Map<string, number>()
  const allTokens = new Set<string>()
  let totalWords = 0

  for (const text of texts) {
    if (typeof text !== 'string' || text.length === 0) continue
    for (const raw of splitStatSentences(text)) {
      const sentence = normalizeSentence(raw)
      if (sentence.length === 0) continue
      sentenceCounts.set(sentence, (sentenceCounts.get(sentence) ?? 0) + 1)

      const tokens = tokenizeWords(sentence).filter((t) => t.length >= minWordLen)
      totalWords += tokens.length
      for (const token of tokens) {
        allTokens.add(token)
        wordCounts.set(token, (wordCounts.get(token) ?? 0) + 1)
      }

      for (let size = 2; size <= maxNgram; size++) {
        for (let i = 0; i + size <= tokens.length; i++) {
          const slice = tokens.slice(i, i + size)
          if (slice.some((t) => stopwords.has(t))) continue
          const ngram = slice.join(' ')
          ngramCounts.set(ngram, (ngramCounts.get(ngram) ?? 0) + 1)
        }
      }
    }
  }

  const share = (count: number): number =>
    totalWords > 0 ? Number((count / totalWords).toFixed(6)) : 0

  const rankedWords = [...wordCounts.entries()]
    .filter(([word]) => !stopwords.has(word))
    .sort(rankEntry)
  const rankedNgrams = [...ngramCounts.entries()].sort(rankEntry)
  const rankedSentences = [...sentenceCounts.entries()]
    .filter(([, count]) => count >= 2)
    .sort(rankEntry)

  const words: StatFreqWord[] = rankedWords
    .slice(0, topK)
    .map(([word, count]) => ({ word, count, share: share(count) }))
  const ngrams: StatFreqNgram[] = rankedNgrams
    .slice(0, topK)
    .map(([ngram, count]) => ({ ngram, count }))
  const sentences: StatFreqSentence[] = rankedSentences
    .slice(0, topK)
    .map(([sentence, count]) => ({ sentence, count }))

  const top: StatFreqTopEntry[] = [
    ...rankedWords.map(([term, count]): StatFreqTopEntry => ({ term, count, kind: 'word' })),
    ...rankedNgrams.map(([term, count]): StatFreqTopEntry => ({ term, count, kind: 'ngram' })),
  ]
    .sort((a, b) => {
      if (a.count !== b.count) return b.count - a.count
      if (a.kind !== b.kind) return a.kind === 'word' ? -1 : 1
      return cmpTerm(a.term, b.term)
    })
    .slice(0, topK)

  return {
    totalWords,
    uniqueWords: allTokens.size,
    words,
    sentences,
    ngrams,
    top,
  }
}

/**
 * Tool: offline statistical frequency analyzer.
 *
 * Reads `env.item` (string) or `env.items` (batched corpus), keeps the envelope
 * cardinality untouched and stores the ranked report in `meta.statFreq`.
 */
export function defineStatFreq(options: StatFreqOptions = {}) {
  return defineTool<string | string[], string | string[]>({
    name: 'stat-freq',
    version: '1.0.0',
    mdDescription:
      'Offline statistical frequency analyzer: counts word, sentence and n-gram frequencies ' +
      '(stopwords filtered) of the envelope text; ranked report in meta.statFreq.',
    async invoke(env: Envelope<string | string[]>): Promise<Envelope<string | string[]>> {
      const items = env.items ?? (Array.isArray(env.item) ? env.item : [env.item])
      const texts = items.filter((text): text is string => typeof text === 'string')
      const report = buildStatFreqReport(texts, options)
      if (options.outFile) {
        await ensureParentDir(options.outFile)
        await atomicWriteFile(options.outFile, `${JSON.stringify(report, null, 2)}\n`)
      }
      return {
        ...env,
        meta: { ...env.meta, statFreq: report },
      }
    },
  })
}

/** Alias of {@link defineStatFreq} (package convention: `create*` factories). */
export const createStatFreq = defineStatFreq

/** Default analyzer: built-in stopwords, n-grams up to 3 words, 500 entries per list. */
export const statFreq = defineStatFreq()
