import { mkdirSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { join, sep } from 'node:path'
import { atomicWriteFile } from '@mt/core'
import { walkFiles } from './file-walk.js'

/** Chapter file base names look like `chapter42.md`. */
const CHAPTER_FILE_RE = /^chapter(\d+)\.md$/i

/**
 * File name of the chapter with the given number, or of the given routing key
 * (`chapter1-counts.md` for the legacy `meta.chapter` form).
 */
export function chapterFileName(chapterKey: number | string): string {
  return `chapter${chapterKey}.md`
}

/**
 * Chapter number encoded in a `chapter<N>.md` file name; `undefined` when the
 * name is not a chapter file.
 */
export function chapterNumFromFileName(name: string): number | undefined {
  const digits = CHAPTER_FILE_RE.exec(name)?.[1]
  if (!digits) return undefined
  const value = Number.parseInt(digits, 10)
  return Number.isNaN(value) ? undefined : value
}

/** Highest `chapterN.md` index directly under `root`, used to continue auto-numbering. */
export async function seedAutoIndex(root: string): Promise<number> {
  let entries: string[]
  try {
    entries = await readdir(root)
  } catch {
    return 0
  }
  let max = 0
  for (const entry of entries) {
    const value = chapterNumFromFileName(entry)
    if (value !== undefined && value > max) max = value
  }
  return max
}

/** Discovered chapter file metadata. */
export interface ChapterFile {
  path: string
  chapterNum: number
  lang: string | undefined
}

/**
 * Recursively walk a directory to find chapter{N}.md files.
 * If a .md file is inside a subdirectory, that subdirectory name is recorded as lang.
 */
export async function discoverChapterFiles(dir: string): Promise<ChapterFile[]> {
  const walked = await walkFiles(
    dir,
    (entry) => {
      if (entry.isDirectory) return 'recurse'
      if (entry.name.endsWith('.md') && CHAPTER_FILE_RE.test(entry.name)) return 'collect'
      return 'skip'
    },
    { onMissingDir: 'ignore' },
  )

  const results: ChapterFile[] = []
  for (const file of walked) {
    const chapterNum = chapterNumFromFileName(file.name)
    if (chapterNum === undefined) continue
    // The lang is the deepest subdirectory name, mirroring the historical walk.
    const lang =
      file.relativeDir === '' ? undefined : (file.relativeDir.split(sep).at(-1) ?? undefined)
    results.push({ path: file.path, chapterNum, lang })
  }

  // Sort by lang then chapter number for deterministic ordering
  results.sort((a, b) => {
    const langCmp = (a.lang ?? '').localeCompare(b.lang ?? '')
    if (langCmp !== 0) return langCmp
    return a.chapterNum - b.chapterNum
  })
  return results
}

/** Write one chapter file (`chapter<key>.md`) into `dir` atomically. */
export async function writeChapterFile(
  dir: string,
  chapterKey: number | string,
  content: unknown,
): Promise<void> {
  mkdirSync(dir, { recursive: true })
  await atomicWriteFile(join(dir, chapterFileName(chapterKey)), String(content))
}

/**
 * Validate a chapter number that arrived untrusted in `meta`. Violations throw
 * an error naming the key — they are never silently rewritten.
 */
export function assertChapterNum(chapterNum: unknown, label: string): asserts chapterNum is number {
  if (typeof chapterNum !== 'number' || !Number.isInteger(chapterNum) || chapterNum < 0) {
    throw new Error(
      `${label}: meta.chapterNum must be a non-negative integer, got ${JSON.stringify(chapterNum)}`,
    )
  }
}

/**
 * Safe single path segment for the legacy `meta.chapter` routing key
 * (`chapter1-counts.md`). Separators and `..` would escape the target root.
 */
const CHAPTER_KEY_RE = /^[\p{L}\p{N}_-]+$/u

/**
 * Validate a legacy `meta.chapter` routing key. A number is held to the same
 * contract as `meta.chapterNum`; a string must be one safe path segment.
 */
export function assertChapterKey(
  chapterKey: unknown,
  label: string,
): asserts chapterKey is number | string {
  if (typeof chapterKey === 'number') {
    if (!Number.isInteger(chapterKey) || chapterKey < 0) {
      throw new Error(
        `${label}: meta.chapter must be a non-negative integer when numeric, got ` +
          `${JSON.stringify(chapterKey)}`,
      )
    }
    return
  }
  if (typeof chapterKey !== 'string' || !CHAPTER_KEY_RE.test(chapterKey)) {
    throw new Error(
      `${label}: meta.chapter must be a non-negative integer or one safe path segment ` +
        `(letters, digits, '_' or '-'), got ${JSON.stringify(chapterKey)}`,
    )
  }
}
