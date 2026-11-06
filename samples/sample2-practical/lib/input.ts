import { chapterNumberOf, onlyChapters } from '@mt/tools'

/** The real book of this sample (project-relative URI; `mt.json` also aliases it as `@book2`). */
export const BOOK2 = 'md://../../books/book2'

/**
 * Keeps only `# Chapter N: ...` documents. `books/book2` also contains `index.md` and `plot.md`,
 * which are useful metadata but never chapter units.
 */
export function chapterOnly(markdown: unknown): boolean {
  const text = String(markdown)
  if (!/^#\s+Chapter\s+\d+\b/m.test(text)) return false
  const only = onlyChapters()
  return only === undefined || only.has(chapterNumberOf(text, 0))
}

/** Chapter number of a markdown chapter (falls back to `fallback`). */
export { chapterNumberOf }
