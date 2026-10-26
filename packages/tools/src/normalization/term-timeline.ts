import type { RuGender } from './ru-grammar.js'
import type { GenderEvidence, Glossary, GlossaryTerm, TermTimelineEntry } from './term-tagger.js'

/** One gender-flip timeline entry; `evidence` is the verbatim source quote backing the flip. */
export type GenderFlipEntry = TermTimelineEntry<RuGender> & { evidence: GenderEvidence }

/** Effective per-term state at one chapter (chapter timeline applied). */
export interface ResolvedTermState {
  /** Effective RU translation at the chapter (`null` = untranslated there). */
  ru: string | null
  /** Effective grammatical gender at the chapter (`null` = unknown). */
  gender: RuGender | null
  /** Gender flip active at the chapter (effective gender differs from the base one), if any. */
  genderFlip: GenderFlipEntry | null
  /** `true` when `firstChapter` is known and lies after this chapter (term not yet introduced). */
  notYetIntroduced: boolean
}

/** Latest timeline entry at or below `chapter` (`null` when none applies). */
function applicableEntry<E extends TermTimelineEntry<unknown>>(
  entries: E[] | undefined,
  chapter: number,
): E | null {
  let best: E | null = null
  for (const entry of entries ?? []) {
    if (entry.chapter <= chapter && (best === null || entry.chapter > best.chapter)) best = entry
  }
  return best
}

/** Resolves a term's RU translation and gender as of `chapter` (timeline overrides applied). */
export function resolveTermAtChapter(term: GlossaryTerm, chapter: number): ResolvedTermState {
  const ruEntry = applicableEntry(term.ruTimeline, chapter)
  const flipEntry = applicableEntry(term.genderTimeline, chapter)
  const baseGender = term.ruGrammar?.gender ?? null
  return {
    ru: ruEntry?.value ?? term.ru,
    gender: flipEntry?.value ?? baseGender,
    genderFlip: flipEntry && flipEntry.value !== baseGender ? flipEntry : null,
    notYetIntroduced: term.firstChapter !== null && chapter < term.firstChapter,
  }
}

/**
 * Copy of `glossary` with every term's state resolved at `chapter`: terms whose
 * `firstChapter` lies after `chapter` are dropped, `ru`/`ruGrammar.gender` carry the
 * effective timeline values. Terms without timeline data keep their identity.
 */
export function resolveGlossaryAtChapter(glossary: Glossary, chapter: number): Glossary {
  const terms = glossary.terms
    .map((term) => {
      const state = resolveTermAtChapter(term, chapter)
      if (state.notYetIntroduced) return null
      const baseGender = term.ruGrammar?.gender ?? null
      if (state.ru === term.ru && state.gender === baseGender) return term
      return {
        ...term,
        ru: state.ru,
        ruGrammar:
          state.gender === null
            ? term.ruGrammar
            : term.ruGrammar
              ? { ...term.ruGrammar, gender: state.gender }
              : undefined,
      }
    })
    .filter((t): t is GlossaryTerm => t !== null)
  return { ...glossary, terms }
}

/** Gender flips active at `chapter`, keyed by term id (only where the gender actually changes). */
export function genderFlipsAt(glossary: Glossary, chapter: number): Map<string, GenderFlipEntry> {
  const flips = new Map<string, GenderFlipEntry>()
  for (const term of glossary.terms) {
    const flip = resolveTermAtChapter(term, chapter).genderFlip
    if (flip) flips.set(term.id, flip)
  }
  return flips
}

export type TimelineIssueCode =
  | 'unsorted-timeline'
  | 'flip-without-evidence'
  | 'empty-evidence-quote'
  | 'quote-not-in-source'

/** One timeline problem found in a glossary entry (report, never thrown). */
export interface TimelineIssue {
  termId: string
  term: string
  code: TimelineIssueCode
  detail: string
}

function isSorted(entries: TermTimelineEntry<unknown>[]): boolean {
  return entries.every((e, i) => i === 0 || (entries[i - 1]?.chapter ?? 0) <= e.chapter)
}

/**
 * Structural timeline validation: ascending chapter order, every gender flip backed by
 * non-empty evidence. Verbatim-ness against the corpus is checked separately by
 * {@link verifyEvidenceQuotes}.
 */
export function validateTimeline(glossary: Glossary): TimelineIssue[] {
  const issues: TimelineIssue[] = []
  for (const term of glossary.terms) {
    if (term.ruTimeline && !isSorted(term.ruTimeline)) {
      issues.push({
        termId: term.id,
        term: term.term,
        code: 'unsorted-timeline',
        detail: 'ruTimeline chapters must be ascending',
      })
    }
    if (term.genderTimeline && !isSorted(term.genderTimeline)) {
      issues.push({
        termId: term.id,
        term: term.term,
        code: 'unsorted-timeline',
        detail: 'genderTimeline chapters must be ascending',
      })
    }
    for (const flip of term.genderTimeline ?? []) {
      if (!flip.evidence) {
        issues.push({
          termId: term.id,
          term: term.term,
          code: 'flip-without-evidence',
          detail: `gender flip at chapter ${flip.chapter} has no source evidence`,
        })
      } else if (flip.evidence.quote.trim() === '') {
        issues.push({
          termId: term.id,
          term: term.term,
          code: 'empty-evidence-quote',
          detail: `gender flip at chapter ${flip.chapter} has an empty evidence quote`,
        })
      }
    }
  }
  return issues
}

/**
 * Checks every gender-flip evidence quote occurs verbatim in the source text of its
 * chapter. `sourceOf` returns the EN source of a chapter (`undefined` when unknown).
 */
export function verifyEvidenceQuotes(
  glossary: Glossary,
  sourceOf: (chapter: number) => string | undefined,
): TimelineIssue[] {
  const issues: TimelineIssue[] = []
  for (const term of glossary.terms) {
    for (const flip of term.genderTimeline ?? []) {
      const quote = flip.evidence?.quote
      if (!quote || quote.trim() === '') continue // reported by validateTimeline
      const source = sourceOf(flip.evidence.chapter)
      if (source === undefined || !source.includes(quote)) {
        issues.push({
          termId: term.id,
          term: term.term,
          code: 'quote-not-in-source',
          detail: `evidence quote not found verbatim in chapter ${flip.evidence.chapter} source`,
        })
      }
    }
  }
  return issues
}
