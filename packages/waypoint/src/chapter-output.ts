import { mkdirSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { isAbsolute, join, relative } from 'node:path'
import type { SourceContext, TargetContext } from '@mt/core'
import type { Exchange, ExchangeInput, MdOutputEntry, Source, Target } from '@mt/core'
import type { ParsedUri } from '@mt/core'
import { MD_OUTPUTS_VARIABLE, atomicWriteFile } from '@mt/core'
import { assertChapterNum, chapterFileName, discoverChapterFiles } from './chapter-files.js'
import { exchangeField } from './fields.js'
import { mdOutputsRejectionError } from './md-outputs.js'
import { registerWaypointPair } from './registration.js'
import { resumeFrom } from './resume.js'
import { resolveUriInContext } from './settings.js'

/**
 * Chapter Output Target — writes chapters to chapters/{lang}/chapter{N}.md.
 *
 * URI scheme: my-target://<base-dir>
 * Example: my-target://./chapters
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

export function createChapterOutputTarget<T>(uri: ParsedUri): Target<T> {
  let chapterIndex = 0
  let baseDir = ''
  let committedEnvelopes = 0

  return {
    uri: uri.raw,
    async open(ctx: TargetContext): Promise<void> {
      chapterIndex = 0
      committedEnvelopes = 0
      baseDir = resolveUriInContext(uri, 'chapter-output', ctx)
      mkdirSync(baseDir, { recursive: true })
      // Resume replay must continue numbering above what is already on disk.
      if (ctx.resumeCursor !== undefined && ctx.resumeCursor > 0) {
        const existing = await discoverChapterFiles(baseDir)
        chapterIndex = existing.reduce((max, file) => Math.max(max, file.chapterNum), 0)
      }
    },
    async write(env: Exchange<T>, _ctx: TargetContext): Promise<void> {
      const mdOutputs = exchangeField<MdOutputEntry[]>(env, MD_OUTPUTS_VARIABLE)
      if (mdOutputs && mdOutputs.length > 0) {
        // This target writes `env.item` as one chapter file per envelope — the
        // per-file intents have nowhere to go, so reject instead of dropping their
        // content silently.
        throw mdOutputsRejectionError('chapter-output target', uri.raw, mdOutputs, 'unsupported')
      }
      const meta = (env.meta || {}) as Record<string, unknown>
      assertSafeLang(meta.lang)
      const lang = meta.lang as string | undefined
      const explicitNum = meta.chapterNum ?? meta.chapter
      const chapterNum =
        explicitNum === undefined || explicitNum === null ? ++chapterIndex : (explicitNum as number)
      assertChapterNum(chapterNum, 'chapter-output target')

      const filename = chapterFileName(chapterNum)

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
      committedEnvelopes += 1
    },
    async checkpoint(): Promise<number> {
      return committedEnvelopes
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
async function* readChapterEnvelopes<T>(baseDir: string): AsyncIterable<ExchangeInput<T>> {
  const files = await discoverChapterFiles(baseDir)
  for (const file of files) {
    const content = await readFile(file.path, 'utf-8')
    yield {
      id: `chapter-output:${file.path}`,
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
    async *start(ctx: SourceContext): AsyncIterable<ExchangeInput<T>> {
      const baseDir = resolveUriInContext(uri, 'chapter-output', ctx)
      yield* readChapterEnvelopes(baseDir)
    },
    async *resume(ctx: SourceContext, cursor: unknown): AsyncIterable<ExchangeInput<T>> {
      const baseDir = resolveUriInContext(uri, 'chapter-output', ctx)
      yield* resumeFrom(() => readChapterEnvelopes(baseDir), cursor)
    },
  }
}

registerWaypointPair({
  id: 'WT004',
  source: {
    factory: createChapterOutputSource,
    name: 'chapter-output source',
    description: 'Reads chapter files recursively from a chapter-output directory.',
    schemes: ['chapter-output'],
  },
  target: {
    factory: createChapterOutputTarget,
    name: 'chapter-output target',
    description: 'Writes chapters to <base-dir>/<lang>/chapter<N>.md files atomically.',
    schemes: ['chapter-output'],
  },
})
