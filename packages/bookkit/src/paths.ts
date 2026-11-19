import { isAbsolute, join, resolve } from 'node:path'

/**
 * Path and URI seams shared by the book stages.
 *
 * The package never guesses a project root: every entry point takes {@link BookPathsOptions}.
 * Samples and consumer projects pass their own root and (optionally) aliases.
 */

export interface BookEnv {
  readonly [key: string]: string | undefined
}

export interface BookPathsOptions {
  /** Consumer project root — the directory that holds `chapters/`. */
  root: string
  /** Absolute chapters directory; defaults to `<root>/chapters`. */
  chaptersDir?: string
  /** Book source URI, normally `@book2` or `md://…`. */
  bookUri?: string
  /** Env source; defaults to `process.env`. */
  env?: BookEnv
  /** Env var overriding the output root URI (default `MT_CHAPTERS_ROOT`). */
  rootEnv?: string
  /** Env var overriding the book source URI (default `MT_BOOK`). */
  bookEnv?: string
  /** Env var forcing the translate/preprocess branch (default `MT_FORCE_BRANCH`). */
  forceBranchEnv?: string
}

export const DEFAULT_ROOT_ENV = 'MT_CHAPTERS_ROOT'
export const DEFAULT_BOOK_ENV = 'MT_BOOK'
export const DEFAULT_FORCE_BRANCH_ENV = 'MT_FORCE_BRANCH'

export function envOf(options: BookPathsOptions): BookEnv {
  return options.env ?? process.env
}

export function chaptersDirOf(options: BookPathsOptions): string {
  return options.chaptersDir ?? join(options.root, 'chapters')
}

/** Output root URI: the configured env var wins, else `@chapters`. */
export function rootUriOf(options: BookPathsOptions): string {
  const env = envOf(options)
  return env[options.rootEnv ?? DEFAULT_ROOT_ENV]?.trim() || '@chapters'
}

function aliasPath(uri: string, options: BookPathsOptions): string | undefined {
  const chaptersDir = chaptersDirOf(options)
  if (uri === '@chapters') return chaptersDir
  if (uri === '@schema') return join(chaptersDir, 'schema')
  if (uri === '@book2' && options.bookUri) return uriPath(options.bookUri, options)
  return undefined
}

/**
 * Filesystem path of a project URI:
 * `@chapters` / `@schema` / `@book2` aliases, `md://` relative paths, or absolute paths.
 * Relative paths anchor at {@link BookPathsOptions.root}.
 */
export function uriPath(uri: string, options: BookPathsOptions): string {
  const raw = uri.replace(/^md:\/\//, '').trim()
  if (isAbsolute(raw)) return raw
  const alias = aliasPath(raw, options)
  if (alias) return alias
  return resolve(options.root, raw)
}

/** Filesystem path of the output root URI. */
export function rootPathOf(options: BookPathsOptions): string {
  return uriPath(rootUriOf(options), options)
}

/** URI of the cleaned chapter branch (`<root>/clean`). */
export function cleanUriFor(options: BookPathsOptions): string {
  const rootUri = rootUriOf(options)
  if (rootUri === '@chapters') return 'md://./chapters/clean'
  if (rootUri.startsWith('md://')) return `${rootUri.replace(/\/$/, '')}/clean`
  return `md://${join(uriPath(rootUri, options), 'clean')}`
}

/** Source URI: the configured env var wins, else {@link BookPathsOptions.bookUri}. */
export function bookUriOf(options: BookPathsOptions): string {
  const env = envOf(options)
  return env[options.bookEnv ?? DEFAULT_BOOK_ENV]?.trim() || options.bookUri || '@book2'
}

/** Branch picked by the quality gate. */
export type Branch = 'translate' | 'preprocess'
