import { ORG_WORDS, PLACE_WORDS, isCommonWord } from './glossary-lexicon.js'
import type { GlossaryChapter } from './term-tagger.js'
import { mapProse } from './term-tagger.js'

/**
 * Named-entity candidates used to seed the glossary (machinum-llm `ProperNameExtractor`).
 *
 * The backend is pluggable: a real NER (T135) can replace the built-in heuristic one.
 * The candidates carry an entity kind, so the glossary can fix a wrong type guess
 * (a place read as a character).
 */

/** Entity kind recognised by a NER backend. */
export type NerKind = 'person' | 'place' | 'organization' | 'other'

/** One entity candidate produced by a NER backend. */
export interface NerCandidate {
  /** Surface form as it appears in the text. */
  text: string
  /** Entity kind. */
  kind: NerKind
  /** Occurrences in the analysed corpus (default 1). */
  count?: number
  /** First chapter the entity appears in (default `null`). */
  firstChapter?: number | null
}

/** Pluggable NER backend: extracts the entity candidates of a corpus. */
export interface NerBackend {
  /** Backend name (diagnostics). */
  name: string
  /** Extracts the entity candidates of a corpus. */
  extract(chapters: GlossaryChapter[]): NerCandidate[] | Promise<NerCandidate[]>
}

/** Capitalised word sequence: `Arin Vale`, `Iron Keep`, `Marta`. */
const PROPER = /\b[A-Z][\p{Ll}]+(?:['’-][\p{Ll}]+)*(?:\s+[A-Z][\p{Ll}]+(?:['’-][\p{Ll}]+)*){0,3}/gu

/** Locative phrase: `into the Iron Keep`, `at Kiln`. */
const LOCATIVE =
  /\b(?:in|into|inside|at|from|near|toward|towards|outside|behind|beyond|across|through|around|along|beside|within)\s+(?:the\s+|a\s+|an\s+)?([A-Z][\p{Ll}]+(?:['’-][\p{Ll}]+)*(?:\s+[A-Z][\p{Ll}]+(?:['’-][\p{Ll}]+)*){0,2})/gu

/** True when the match sits inside a `[bracketed]` system message. */
function insideBrackets(text: string, index: number): boolean {
  const open = text.lastIndexOf('[', index)
  const close = text.lastIndexOf(']', index)
  return open > close
}

/** Drops the leading/trailing common words of a phrase (`The Iron Keep` -> `Iron Keep`). */
function trimCommon(phrase: string): string {
  const words = phrase.split(/\s+/)
  let lo = 0
  let hi = words.length - 1
  while (lo <= hi && isCommonWord(words[lo] ?? '')) lo++
  while (hi >= lo && isCommonWord(words[hi] ?? '')) hi--
  return words.slice(lo, hi + 1).join(' ')
}

/** Kind of a proper-name phrase, guessed from its last word. */
function kindOf(phrase: string): NerKind {
  const words = phrase.split(/\s+/)
  const last = words[words.length - 1] ?? ''
  if (PLACE_WORDS.test(last)) return 'place'
  if (ORG_WORDS.test(last)) return 'organization'
  if (words.length >= 2) return 'person'
  return isCommonWord(last) ? 'other' : 'person'
}

/**
 * Built-in NER backend: a pure-JS heuristic that finds proper names and locative phrases.
 *
 * It never drops a candidate for being rare (unlike the glossary extractor), so it seeds
 * the glossary with entities the frequency heuristics would miss.
 */
export function createHeuristicNerBackend(): NerBackend {
  return {
    name: 'heuristic',
    extract(chapters: GlossaryChapter[]): NerCandidate[] {
      const found = new Map<string, NerCandidate>()
      const bump = (text: string, kind: NerKind, chapter: number): void => {
        const key = text.toLowerCase()
        const current = found.get(key)
        if (current) {
          current.count = (current.count ?? 1) + 1
          current.firstChapter = Math.min(current.firstChapter ?? chapter, chapter)
          return
        }
        found.set(key, { text, kind, count: 1, firstChapter: chapter })
      }

      for (const { chapter, text } of chapters) {
        mapProse(text, (segment) => {
          for (const match of segment.matchAll(PROPER)) {
            const at = match.index ?? 0
            if (insideBrackets(segment, at)) continue
            const phrase = trimCommon(match[0])
            if (phrase === '' || isCommonWord(phrase)) continue
            bump(phrase, kindOf(phrase), chapter)
          }
          for (const match of segment.matchAll(LOCATIVE)) {
            const at = match.index ?? 0
            if (insideBrackets(segment, at)) continue
            const phrase = trimCommon(match[1] ?? '')
            if (phrase === '' || isCommonWord(phrase)) continue
            bump(phrase, 'place', chapter)
          }
          return segment
        })
      }
      return [...found.values()].filter((c) => c.text.includes(' ') || (c.count ?? 0) >= 2)
    },
  }
}

/** The default NER backend (the built-in heuristic one). */
export const heuristicNerBackend: NerBackend = createHeuristicNerBackend()
