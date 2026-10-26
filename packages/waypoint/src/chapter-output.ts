import { mkdirSync } from 'node:fs'
import type { Stats } from 'node:fs'
import { readFile, readdir, stat } from 'node:fs/promises'
import { basename, extname, isAbsolute, join, relative } from 'node:path'
import type { SourceContext, TargetContext } from '@mt/core'
import type { Envelope, Source, Target } from '@mt/core'
import type { ParsedUri } from '@mt/core'
import { atomicWriteFile, registry } from '@mt/core'
import { resumeFrom } from './resume.js'
import { resolveWaypointPath } from './settings.js'

/**
 * Chapter Output Target — writes chapters to chapters/{lang}/chapter{N}.md.
 *
 * URI scheme: chapter-output://<base-dir>
 * Example: chapter-output://./chapters
 *
 * Envelope meta:
 *   - lang: language code (e.g. 'ru', 'en'); used as subdirectory
 *   - chapterNum: chapter number; used to generate chapter{N}.md filename
 *
 * Output path: <base-dir>/<lang>/chapter<num>.md
 * If lang is not provided, writes directly to <base-dir>/chapter<num>.md
 *
 * Path-safety contract (mirrors md.ts T087): `meta` arrives uncast from
 * sources/LLMs/flatMaps, so both keys are validated before any mkdir —
 * violations throw a descriptive error naming the key, never silently
 * rewritten:
 *   - lang must be a single safe path segment: /^[\p{L}\p{N}_-]+$/u
 *     (no separators, no '..', so it cannot escape <base-dir>)
 *   - chapterNum (or legacy chapter) must be a non-negative integer;
 *     the auto-increment fallback is always safe
 * The final path is additionally asserted inside <base-dir> (no '..'
 * prefix) as defence in depth.
 *
 * Each chapter file is written atomically (temp → rename), so a crash never
 * leaves a half-written chapter behind.
 *
 * Template: chapters/{lang}/chapter{num}.md
 */

const LANG_SEGMENT_RE = /^[\p{L}\p{N}_-]+$/u

function assertSafeLang(lang: unknown): asserts lang is string | undefined {
  if (lang === undefined || lang === null || lang === '') return
  if (typeof lang !== 'string' || !LANG_SEGMENT_RE.test(lang)) {
    throw new Error(
      `chapter-output target: meta.lang must be a single safe path segment (letters, digits, '_' or '-'), got ${JSON.stringify(lang)}`,
    )
  }
}

function assertChapterNum(chapterNum: unknown): asserts chapterNum is number {
  if (typeof chapterNum !== 'number' || !Number.isInteger(chapterNum) || chapterNum < 0) {
    throw new Error(
      `chapter-output target: meta.chapterNum must be a non-negative integer, got ${JSON.stringify(chapterNum)}`,
    )
  }
}
export function createChapterOutputTarget<T>(uri: ParsedUri): Target<T> {
  let chapterIndex = 0
  let baseDir = ''

  return {
    uri: uri.raw,
    async open(ctx: TargetContext): Promise<void> {
      chapterIndex = 0
      baseDir = resolveWaypointPath(uri, 'chapter-output', ctx.run.global.settings)
      mkdirSync(baseDir, { recursive: true })
    },
    async write(env: Envelope<T>, _ctx: TargetContext): Promise<void> {
      const meta = (env.meta || {}) as Record<string, unknown>
      assertSafeLang(meta.lang)
      const lang = meta.lang as string | undefined
      const explicitNum = meta.chapterNum ?? meta.chapter
      const chapterNum =
        explicitNum === undefined || explicitNum === null ? ++chapterIndex : (explicitNum as number)
      assertChapterNum(chapterNum)

      const filename = `chapter${chapterNum}.md`

      let dir = baseDir
      if (lang) {
        dir = join(baseDir, lang)
      }
      mkdirSync(dir, { recursive: true })

      const filePath = join(dir, filename)
      const rel = relative(baseDir, filePath)
      if (rel.startsWith('..') || isAbsolute(rel)) {
        throw new Error(`chapter-output target: output path escapes the target root: '${rel}'`)
      }
      const text = String(env.item)
      // Atomic: a crash mid-write leaves the previous chapter intact, never a truncated one.
      await atomicWriteFile(filePath, text)
    },
    async close(_ctx: TargetContext): Promise<void> {
      // Nothing to close — each write creates its own file
    },
  }
}

/**
 * Chapter Output Source — reads chapter files from a chapter-output directory.
 *
 * Recursively walks <base-dir> to find chapter{N}.md files.
 * Yields each file's content as an envelope with meta:
 *   - lang: subdirectory name (if nested under a lang directory)
 *   - chapterNum: parsed from filename
 *   - filePath: full path to the chapter file
 */
async function* readChapterEnvelopes<T>(baseDir: string): AsyncIterable<Envelope<T>> {
  const files = await discoverChapterFiles(baseDir)
  for (const file of files) {
    const content = await readFile(file.path, 'utf-8')
    yield {
      item: content as T,
      meta: {
        chapterNum: file.chapterNum,
        lang: file.lang,
        filePath: file.path,
      },
    }
  }
}

export function createChapterOutputSource<T>(uri: ParsedUri): Source<T> {
  return {
    uri: uri.raw,
    lifestyle: 'resumable',
    async *start(ctx: SourceContext): AsyncIterable<Envelope<T>> {
      const baseDir = resolveWaypointPath(uri, 'chapter-output', ctx.run.global.settings)
      yield* readChapterEnvelopes(baseDir)
    },
    async *resume(ctx: SourceContext, cursor: unknown): AsyncIterable<Envelope<T>> {
      const baseDir = resolveWaypointPath(uri, 'chapter-output', ctx.run.global.settings)
      yield* resumeFrom(() => readChapterEnvelopes(baseDir), cursor)
    },
  }
}

/**
 * Discovered chapter file metadata.
 */
interface ChapterFile {
  path: string
  chapterNum: number
  lang: string | undefined
}

/**
 * Recursively walk a directory to find chapter{N}.md files.
 * Chapter files are .md files matching /^chapter(\d+)\.md$/i.
 * If a .md file is inside a subdirectory, that subdirectory name is recorded as lang.
 */
async function discoverChapterFiles(dir: string): Promise<ChapterFile[]> {
  const results: ChapterFile[] = []

  async function walk(currentDir: string, lang?: string): Promise<void> {
    let entries: string[]
    try {
      entries = await readdir(currentDir)
    } catch {
      return // Directory doesn't exist or can't be read
    }

    for (const entry of entries) {
      const fullPath = join(currentDir, entry)
      let fileStat: Stats
      try {
        fileStat = await stat(fullPath)
      } catch {
        continue
      }

      if (fileStat.isDirectory()) {
        // Recurse into subdirectory; its name becomes lang
        await walk(fullPath, entry)
      } else if (fileStat.isFile() && extname(entry) === '.md') {
        const match = basename(entry, '.md').match(/^chapter(\d+)$/i)
        if (match) {
          const group = match[1]
          if (!group) continue
          const chapterNum = Number.parseInt(group, 10)
          if (!Number.isNaN(chapterNum)) {
            results.push({ path: fullPath, chapterNum, lang })
          }
        }
      }
    }
  }

  await walk(dir)
  // Sort by lang then chapter number for deterministic ordering
  results.sort((a, b) => {
    const langCmp = (a.lang ?? '').localeCompare(b.lang ?? '')
    if (langCmp !== 0) return langCmp
    return a.chapterNum - b.chapterNum
  })
  return results
}

// Register built-in Chapter Output source and target
registry.registerSource('chapter-output', createChapterOutputSource)
registry.registerTarget('chapter-output', createChapterOutputTarget)
