import { resolve } from 'node:path'

/** The sample project root (`samples/sample2-practical`). */
export const ROOT = resolve(import.meta.dirname, '..')

/** The real book of this sample (project-relative URI; `mt.json` also aliases it as `@book2`). */
export const BOOK2 = 'md://../../books/book2'

/** Chapters directory of this sample. */
export const CHAPTERS_DIR = resolve(ROOT, 'chapters')

/** Root + book URI every `@mt/bookkit` stage needs. */
export const BOOK_OPTIONS = {
  root: ROOT,
  bookUri: BOOK2,
  rootEnv: 'MT_QUALITY_ROOT',
  bookEnv: 'MT_QUALITY_BOOK',
} as const
