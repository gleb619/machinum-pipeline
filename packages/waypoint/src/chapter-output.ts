import { mkdirSync } from 'node:fs'
import type { Stats } from 'node:fs'
import { readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'
import type { SourceContext, TargetContext } from '@mt/core'
import type { Envelope, Source, Target } from '@mt/core'
import type { ParsedUri } from '@mt/core'
import { registry } from '@mt/core'

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
 * Template: chapters/{lang}/chapter{num}.md
 */
export function createChapterOutputTarget<T>(uri: ParsedUri): Target<T> {
  const baseDir = uri.path || uri.host
  mkdirSync(baseDir, { recursive: true })
  let chapterIndex = 0

  return {
    uri: uri.raw,
    async open(_ctx: TargetContext): Promise<void> {
      chapterIndex = 0
    },
    async write(env: Envelope<T>, _ctx: TargetContext): Promise<void> {
      const meta = (env.meta || {}) as Record<string, unknown>
      const lang = meta.lang as string | undefined
      const chapterNum = (meta.chapterNum as number) ?? (meta.chapter as number) ?? ++chapterIndex

      const filename = `chapter${chapterNum}.md`

      let dir = baseDir
      if (lang) {
        dir = join(baseDir, lang)
      }
      mkdirSync(dir, { recursive: true })

      const filePath = join(dir, filename)
      const text = String(env.item)
      await writeFile(filePath, text, 'utf-8')
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
export function createChapterOutputSource<T>(uri: ParsedUri): Source<T> {
  const baseDir = uri.path || uri.host

  return {
    uri: uri.raw,
    lifestyle: 'resumable',
    async *start(_ctx: SourceContext): AsyncIterable<Envelope<T>> {
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
    },
    async *resume(_ctx: SourceContext, _cursor: unknown): AsyncIterable<Envelope<T>> {
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
