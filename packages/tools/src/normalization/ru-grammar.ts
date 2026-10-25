import { defineTool } from '@mt/core'
import type { Envelope } from '@mt/core'

import { atomicWriteFile, ensureParentDir } from '../core/fs-write.js'
import { readGlossaryFile, serializeGlossary } from './glossary-extractor.js'
import type { Glossary, GlossaryTerm } from './term-tagger.js'

/** Russian grammatical gender. */
export type RuGender = 'm' | 'f' | 'n'

/** Declension class per the traditional school taxonomy. */
export type RuDeclension = 1 | 2 | 3 | 'indeclinable'

/** Six traditional Russian cases. */
export const RU_CASES = [
  'nominative',
  'genitive',
  'dative',
  'accusative',
  'instrumental',
  'prepositional',
] as const

export type RuCase = (typeof RU_CASES)[number]

export type RuNumber = 'singular' | 'plural'

/** Endings table: the string to append to the stem for each case/number. */
export type RuEndings = Record<RuCase, { singular: string; plural: string }>

/** Morphology metadata attached to a glossary entry. */
export interface RuGrammar {
  gender: RuGender
  declension: RuDeclension
  endings: RuEndings
}

const F_1_A_ENDINGS: RuEndings = {
  nominative: { singular: 'а', plural: 'ы' },
  genitive: { singular: 'ы', plural: '' },
  dative: { singular: 'е', plural: 'ам' },
  accusative: { singular: 'у', plural: 'ы' },
  instrumental: { singular: 'ой', plural: 'ами' },
  prepositional: { singular: 'е', plural: 'ах' },
}

const F_1_YA_ENDINGS: RuEndings = {
  nominative: { singular: 'я', plural: 'и' },
  genitive: { singular: 'и', plural: '' },
  dative: { singular: 'е', plural: 'ям' },
  accusative: { singular: 'ю', plural: 'и' },
  instrumental: { singular: 'ей', plural: 'ями' },
  prepositional: { singular: 'е', plural: 'ях' },
}

const M_2_HARD_ENDINGS: RuEndings = {
  nominative: { singular: '', plural: 'ы' },
  genitive: { singular: 'а', plural: 'ов' },
  dative: { singular: 'у', plural: 'ам' },
  accusative: { singular: '', plural: 'ы' },
  instrumental: { singular: 'ом', plural: 'ами' },
  prepositional: { singular: 'е', plural: 'ах' },
}

const M_2_SOFT_ENDINGS: RuEndings = {
  nominative: { singular: 'ь', plural: 'и' },
  genitive: { singular: 'я', plural: 'ей' },
  dative: { singular: 'ю', plural: 'ям' },
  accusative: { singular: 'ь', plural: 'и' },
  instrumental: { singular: 'ем', plural: 'ями' },
  prepositional: { singular: 'е', plural: 'ях' },
}

const N_2_O_ENDINGS: RuEndings = {
  nominative: { singular: 'о', plural: 'а' },
  genitive: { singular: 'а', plural: '' },
  dative: { singular: 'у', plural: 'ам' },
  accusative: { singular: 'о', plural: 'а' },
  instrumental: { singular: 'ом', plural: 'ами' },
  prepositional: { singular: 'е', plural: 'ах' },
}

const N_2_E_ENDINGS: RuEndings = {
  nominative: { singular: 'е', plural: 'я' },
  genitive: { singular: 'я', plural: 'ей' },
  dative: { singular: 'ю', plural: 'ям' },
  accusative: { singular: 'е', plural: 'я' },
  instrumental: { singular: 'ем', plural: 'ями' },
  prepositional: { singular: 'е', plural: 'ях' },
}

const N_2_IE_ENDINGS: RuEndings = {
  nominative: { singular: 'ие', plural: 'ия' },
  genitive: { singular: 'ия', plural: 'ий' },
  dative: { singular: 'ию', plural: 'иям' },
  accusative: { singular: 'ие', plural: 'ия' },
  instrumental: { singular: 'ием', plural: 'иями' },
  prepositional: { singular: 'ии', plural: 'иях' },
}

const F_3_ENDINGS: RuEndings = {
  nominative: { singular: 'ь', plural: 'и' },
  genitive: { singular: 'и', plural: 'ей' },
  dative: { singular: 'и', plural: 'ям' },
  accusative: { singular: 'ь', plural: 'и' },
  instrumental: { singular: 'ью', plural: 'ями' },
  prepositional: { singular: 'и', plural: 'ях' },
}

const INDECLINABLE_ENDINGS: RuEndings = {
  nominative: { singular: '', plural: '' },
  genitive: { singular: '', plural: '' },
  dative: { singular: '', plural: '' },
  accusative: { singular: '', plural: '' },
  instrumental: { singular: '', plural: '' },
  prepositional: { singular: '', plural: '' },
}

/** Common borrowed/indeclinable words ending in a vowel. */
const KNOWN_INDELINABLES = new Set([
  'пальто',
  'кафе',
  'кино',
  'метро',
  'такси',
  'шоссе',
  'бюро',
  'жюри',
  'пенсне',
  'какао',
])

const VELAR_SIBILANT_RE = /[кгхжчшщц]$/
const SIBILANT_RE = /[жчшщц]$/

function mapEndings(stem: string, endings: RuEndings): RuEndings {
  const velarSibilant = VELAR_SIBILANT_RE.test(stem)
  const sibilant = SIBILANT_RE.test(stem)
  if (!velarSibilant && !sibilant) return endings

  const apply = (value: string): string => {
    let out = value
    if (velarSibilant) out = out.replace(/ы/g, 'и')
    if (sibilant) {
      out = out.replace(/я/g, 'а')
      out = out.replace(/ой$/, 'ей')
    }
    return out
  }

  return Object.fromEntries(
    RU_CASES.map((c) => [
      c,
      { singular: apply(endings[c].singular), plural: apply(endings[c].plural) },
    ]),
  ) as RuEndings
}

function makeRuGrammar(gender: RuGender, declension: RuDeclension, endings: RuEndings): RuGrammar {
  return { gender, declension, endings }
}

/**
 * Heuristic morphology inference from the nominative singular form.
 *
 * Limitations: stress, exceptions, animate accusative, and stem alternations
 * are out of scope. Some borrowed nouns (пальто, кафе, …) are recognised as
 * indeclinable; everything else ending in a non-Cyrillic letter falls back to
 * indeclinable too.
 */
export function inferRuGrammar(word: string): RuGrammar {
  const w = word.trim().toLowerCase()
  if (w === '' || KNOWN_INDELINABLES.has(w) || /[^а-яё]/.test(w)) {
    return makeRuGrammar('n', 'indeclinable', INDECLINABLE_ENDINGS)
  }

  if (w.endsWith('ие')) {
    return makeRuGrammar('n', 2, N_2_IE_ENDINGS)
  }
  if (w.endsWith('ё') || w.endsWith('е')) {
    return makeRuGrammar('n', 2, N_2_E_ENDINGS)
  }
  if (w.endsWith('о')) {
    return makeRuGrammar('n', 2, N_2_O_ENDINGS)
  }
  if (w.endsWith('а')) {
    return makeRuGrammar('f', 1, mapEndings(w.slice(0, -1), F_1_A_ENDINGS))
  }
  if (w.endsWith('я')) {
    return makeRuGrammar('f', 1, mapEndings(w.slice(0, -1), F_1_YA_ENDINGS))
  }
  if (w.endsWith('ь')) {
    const prev = w[w.length - 2]
    if (prev !== undefined && /[жчшщц]/.test(prev)) {
      return makeRuGrammar('f', 3, mapEndings(w.slice(0, -1), F_3_ENDINGS))
    }
    return makeRuGrammar('m', 2, M_2_SOFT_ENDINGS)
  }

  return makeRuGrammar('m', 2, mapEndings(w, M_2_HARD_ENDINGS))
}

/** Returns the stem of `word` according to the inferred grammar. */
function ruStem(word: string, grammar: RuGrammar): string {
  const base = grammar.endings.nominative.singular
  return word.slice(0, word.length - base.length)
}

/**
 * Inflect a Russian noun into one case/number.
 *
 * `number` defaults to singular. Returns the input word unchanged for
 * indeclinable entries.
 */
export function declineRu(
  word: string,
  grammar: RuGrammar,
  ruCase: RuCase,
  number: RuNumber = 'singular',
): string {
  if (grammar.declension === 'indeclinable') return word
  return ruStem(word, grammar) + grammar.endings[ruCase][number]
}

/** A full declension table produced from a concrete word. */
export type RuDeclensionTable = Record<RuCase, { singular: string; plural: string }>

/** Builds all 12 inflected forms (6 cases × 2 numbers). */
export function declineAllRu(word: string, grammar: RuGrammar): RuDeclensionTable {
  if (grammar.declension === 'indeclinable') {
    const same = word
    return Object.fromEntries(
      RU_CASES.map((c) => [c, { singular: same, plural: same }]),
    ) as RuDeclensionTable
  }

  const stem = ruStem(word, grammar)
  return Object.fromEntries(
    RU_CASES.map((c) => [
      c,
      {
        singular: stem + grammar.endings[c].singular,
        plural: stem + grammar.endings[c].plural,
      },
    ]),
  ) as RuDeclensionTable
}

/** One reported deviation from the expected paradigm. */
export interface RuGrammarIssue {
  /** Glossary term id. */
  termId: string
  /** Canonical EN surface form. */
  term: string
  /** Canonical RU translation (nominative singular). */
  ru: string
  /** The offending word in the text. */
  found: string
  /** All valid forms for this term. */
  expected: string[]
}

/** Result of `validateRuInflection`. */
export interface RuGrammarReport {
  ok: boolean
  checked: number
  issues: RuGrammarIssue[]
}

const WORD_RE = /[a-zA-Zа-яёА-ЯЁ]+/gu

function extractWords(text: string): string[] {
  return [...text.matchAll(WORD_RE)].map((m) => m[0])
}

function maxEndingLength(grammar: RuGrammar): number {
  if (grammar.declension === 'indeclinable') return 0
  let max = 0
  for (const c of RU_CASES) {
    max = Math.max(max, grammar.endings[c].singular.length, grammar.endings[c].plural.length)
  }
  return max
}

/**
 * Checks every Russian word in `text` that could be an inflected form of a
 * glossary entry against the entry's `ruGrammar`. Deviations are reported,
 * never thrown.
 */
export function validateRuInflection(text: string, glossary: Glossary): RuGrammarReport {
  const tokens = extractWords(text)
  const issues: RuGrammarIssue[] = []
  let checked = 0

  for (const term of glossary.terms) {
    const ru = term.ru
    const grammar = (term as GlossaryTerm & { ruGrammar?: RuGrammar }).ruGrammar
    if (!ru || !grammar) continue

    checked++
    const table = declineAllRu(ru, grammar)
    const validForms = new Set<string>()
    for (const c of RU_CASES) {
      validForms.add(table[c].singular.toLowerCase())
      validForms.add(table[c].plural.toLowerCase())
    }

    const stem =
      grammar.declension === 'indeclinable' ? ru.toLowerCase() : ruStem(ru.toLowerCase(), grammar)
    const endingLimit = maxEndingLength(grammar)

    const seen = new Set<string>()
    for (const token of tokens) {
      const low = token.toLowerCase()
      if (!low.startsWith(stem)) continue
      if (low.length < stem.length || low.length > stem.length + endingLimit) continue
      if (validForms.has(low)) continue
      if (seen.has(low)) continue
      seen.add(low)
      issues.push({
        termId: term.id,
        term: term.term,
        ru,
        found: token,
        expected: [...validForms],
      })
    }
  }

  return { ok: issues.length === 0, checked, issues }
}

/** Adds inferred `ruGrammar` to every glossary entry that has `ru` but no grammar. */
export function inferRuGrammarForGlossary(glossary: Glossary): Glossary {
  let changed = false
  const terms = glossary.terms.map((term) => {
    if (term.ruGrammar || !term.ru) return term
    changed = true
    return { ...term, ruGrammar: inferRuGrammar(term.ru) }
  })

  return changed ? { ...glossary, terms } : glossary
}

/** Options for {@link createRuGrammarTool}. */
export interface RuGrammarToolOptions {
  /** Glossary file to read and, optionally, enrich. */
  glossaryFile?: string
  /** Infer grammar for entries that have `ru` but no `ruGrammar`. */
  inferMissing?: boolean
}

/**
 * Tool: validates Russian inflections in the text against `meta.glossary` and
 * optionally writes inferred grammar back to a glossary file atomically.
 */
export function createRuGrammarTool(options: RuGrammarToolOptions = {}) {
  return defineTool<string | string[], string | string[]>({
    name: 'ru-grammar',
    version: '1.0.0',
    mdDescription:
      'Validates Russian inflected forms against glossary `ruGrammar`; reports ' +
      'deviations in `meta.ruGrammar` and can infer missing grammar for a glossary file.',
    async invoke(env: Envelope<string | string[]>): Promise<Envelope<string | string[]>> {
      const inputs = (env.items ?? [env.item]).flat()
      const text = inputs.join('\n')
      const metaGlossary = env.meta.glossary as Glossary | undefined
      let glossary = metaGlossary
      if (!glossary && options.glossaryFile) {
        glossary = (await readGlossaryFile(options.glossaryFile)) ?? { terms: [] }
      }

      const report = glossary
        ? validateRuInflection(text, glossary)
        : { ok: true, checked: 0, issues: [] as RuGrammarIssue[] }

      if (options.glossaryFile && options.inferMissing && glossary) {
        const enriched = inferRuGrammarForGlossary(glossary)
        if (enriched !== glossary) {
          await ensureParentDir(options.glossaryFile)
          await atomicWriteFile(options.glossaryFile, serializeGlossary(enriched))
        }
      }

      return { ...env, meta: { ...env.meta, ruGrammar: report } }
    },
  })
}

export const ruGrammarTool = createRuGrammarTool()
