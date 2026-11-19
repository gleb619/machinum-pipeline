import { chapterOnly as chapterOnlyOf, createBookSource } from '@mt/bookkit'
import { BOOK2, BOOK_OPTIONS } from './config.js'

/** The real book of this sample (project-relative URI; `mt.json` also aliases it as `@book2`). */
export { BOOK2 }

/**
 * Source of the translation stage, decided by the quality gate.
 * See `@mt/bookkit` `createBookSource` for the branch contract.
 */
export const bookSource = createBookSource({
  ...BOOK_OPTIONS,
  cleanUri: 'md://./chapters/clean',
})

/**
 * Keeps only `# Chapter N: ...` documents. `books/book2` also contains `index.md` and `plot.md`,
 * which are useful metadata but never chapter units.
 */
export function chapterOnly(markdown: unknown): boolean {
  return chapterOnlyOf(markdown)
}

/** Chapter number of a markdown chapter (falls back to `fallback`). */
export { chapterNumberOf } from '@mt/bookkit'
