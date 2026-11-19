import { readFileSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import {
  type Exchange,
  type ToolContext,
  batchMembersOf,
  defineTool,
  getVariable,
  setVariable,
  withItem,
} from '@mt/core'
import { appendMdOutput, createSeriesSplitTool } from '@mt/tools'
import type { StatsArtifact } from './stats.js'

/**
 * Stage 1b of the book flow: split chapters larger than the book threshold and give every part a
 * stable, book-wide sequential id.
 *
 * `packages/tools/src/normalization/text-splitter.ts:~239` keeps the source `number` on every
 * part (`chapter.title`, `doc.number`), so a split chapter would collide with itself. This glue
 * therefore renumbers the whole book 1..N and records the mapping in
 * `chapters/schema/chapter-map.json`.
 *
 * Identity case: when no chapter is oversized, `planSplit` still produces the 1..N map (every
 * entry `part:1, of:1`) but no chapter files — a copy would only duplicate the source tree. The
 * pipeline then points downstream at the original directory. `lib/input.ts bookSource()` (step 10)
 * reads `chapters/schema/chapter-map.json`: identity map ⇒ keep `books/book2`; otherwise read
 * `chapters/split/chapter<id>.md`.
 */

export const ROOT = resolve(import.meta.dirname, '..')

/** Test seam: source book directory URI (default `@book2`). */
export const SOURCE_ENV = 'MT_SPLIT_BOOK'
/** Test seam: output root URI (default `@chapters`); stats are read from `<root>/schema/stats.json`. */
export const ROOT_ENV = 'MT_SPLIT_ROOT'

export function splitSourceUri(): string {
  return process.env[SOURCE_ENV]?.trim() || '@book2'
}

export function splitRootUri(): string {
  return process.env[ROOT_ENV]?.trim() || '@chapters'
}

/** Filesystem path of an `md://` URI; relative paths anchor at the sample root. */
function mdUriPath(uri: string): string {
  const raw = uri.replace(/^md:\/\//, '')
  return isAbsolute(raw) ? raw : resolve(ROOT, raw)
}

/** Default stats artefact, or `<MT_SPLIT_ROOT>/schema/stats.json` for an isolated fixture run. */
export function statsPath(): string {
  const root = process.env[ROOT_ENV]?.trim()
  return root
    ? join(mdUriPath(root), 'schema', 'stats.json')
    : join(ROOT, 'chapters', 'schema', 'stats.json')
}

export function readStats(path = statsPath()): StatsArtifact {
  const stats = JSON.parse(readFileSync(path, 'utf-8')) as StatsArtifact
  if (!Number.isFinite(stats.book?.threshold)) {
    throw new Error(`split: ${path} has no numeric book.threshold — run runner:stats first`)
  }
  return stats
}

export interface ChapterMapEntry {
  /** Chapter number in the source book. */
  orig: number
  /** 1-based part index within the source chapter. */
  part: number
  /** Number of parts the source chapter was split into (1 for an unsplit chapter). */
  of: number
}

/** `{ "<id>": { orig, part, of } }`, serialized in ascending id order. */
export type ChapterMap = Record<string, ChapterMapEntry>

/** One source chapter after the series splitter ran on it (1 part when it stayed whole). */
export interface SplitUnit {
  orig: number
  /** H1 of the source chapter, e.g. `Chapter 3: Salt Row`. */
  title: string
  parts: string[]
}

export interface SplitPlan {
  map: ChapterMap
  /** Renumbered chapter markdown, empty when nothing was split. */
  files: { id: number; markdown: string }[]
  split: boolean
}

function headingOf(markdown: string): string {
  return /^#[ \t]+(.+)$/m.exec(markdown)?.[1]?.trim() ?? ''
}

/** `Chapter 3: Salt Row` -> `Salt Row`; a heading without the prefix is kept verbatim. */
export function baseTitleOf(title: string): string {
  const stripped = title.replace(/^Chapter\s+\d+\s*[:.\-–—]?\s*/i, '').trim()
  return stripped || title
}

export function partTitleOf(base: string, id: number, part: number, of: number): string {
  return `Chapter ${id}: ${base}${of > 1 ? ` (part ${part}/${of})` : ''}`
}

/** Replace the H1 (the only heading a chapter document carries) with a renumbered title. */
export function rewriteHeading(markdown: string, title: string): string {
  if (!/^#[ \t]+[^\r\n]*/m.test(markdown)) {
    throw new Error('split: cannot renumber a chapter without an H1 heading')
  }
  return markdown.replace(/^#[ \t]+[^\r\n]*/m, `# ${title}`)
}

/**
 * Renumber the book id-sequentially in source order. Parts of one source chapter keep a
 * contiguous id range; the map round-trips (`orig` + `part`/`of` reconstructs the original
 * numbering). No timestamps, no randomness: the same units serialize byte-identically.
 */
export function planSplit(units: readonly SplitUnit[]): SplitPlan {
  const ordered = [...units].sort((left, right) => left.orig - right.orig)
  const map: ChapterMap = {}
  const files: { id: number; markdown: string }[] = []
  const split = ordered.some((unit) => unit.parts.length > 1)
  let id = 0

  for (const unit of ordered) {
    const of = unit.parts.length
    const base = baseTitleOf(unit.title)
    for (let index = 0; index < of; index++) {
      id += 1
      map[String(id)] = { orig: unit.orig, part: index + 1, of }
      if (!split) continue
      const part = unit.parts[index] ?? ''
      files.push({ id, markdown: rewriteHeading(part, partTitleOf(base, id, index + 1, of)) })
    }
  }

  return { map, files, split }
}

export function serializeChapterMap(map: ChapterMap): string {
  return `${JSON.stringify(map, null, 2)}\n`
}

/** Variable carrying one chapter's {@link SplitUnit} to the aggregation stage. */
export const VAR_SPLIT_UNIT = 'splitUnit'

let cachedSplitter: ReturnType<typeof createSeriesSplitTool> | undefined

/**
 * Splitter pinned to the book threshold. The balanced strategy derives
 * `ceil(meaningfulBody / targetChars)` parts and leaves chapters at or below the target whole,
 * so only `stats.json`'s oversize chapters split.
 */
function seriesSplitter(): ReturnType<typeof createSeriesSplitTool> {
  cachedSplitter ??= createSeriesSplitTool({
    targetChars: Math.floor(readStats().book.threshold),
  })
  return cachedSplitter
}

/**
 * Per-chapter stage: run the series splitter and record `{ orig, title, parts }`. The splitter
 * keeps the source chapter number on every part, which is why the aggregate stage renumbers.
 */
export const splitChapter = defineTool<string, string[]>({
  name: 'split-chapter',
  version: '1.0.0',
  description:
    'Splits a chapter larger than the book threshold into series parts and records the split unit.',
  async invoke(env: Exchange<string>, ctx: ToolContext): Promise<Exchange<string[]>> {
    const orig = Number(env.meta.chapterNum ?? 0)
    const title = headingOf(env.item)
    const split = await seriesSplitter().invoke(env, ctx)
    const parts = split.item.map(String)
    return setVariable(withItem(env, parts), VAR_SPLIT_UNIT, { orig, title, parts })
  },
})

/**
 * Aggregation stage: renumber the book and emit `schema/chapter-map.json` (plus
 * `split/chapter<id>.md` only when at least one chapter was split).
 */
export const writeSplitOutputs = defineTool<unknown, unknown>({
  name: 'write-split-outputs',
  version: '1.0.0',
  description:
    'Renumbers the book sequentially and emits chapter-map.json; emits split/chapter<id>.md when a chapter was split.',
  async invoke(env) {
    const members = batchMembersOf<unknown>(env) ?? []
    const units = members
      .map((member) => getVariable<SplitUnit>(member, VAR_SPLIT_UNIT))
      .filter((unit): unit is SplitUnit => unit !== undefined)
    if (units.length === 0) {
      throw new Error(
        'write-split-outputs: no chapter units in the batch (split stage did not run)',
      )
    }

    const plan = planSplit(units)
    let out = withItem(env, '')
    if (plan.split) {
      for (const file of plan.files) {
        out = appendMdOutput(out, {
          name: 'split-chapter',
          subdir: 'split',
          filename: `chapter${file.id}.md`,
          content: file.markdown,
        })
      }
    }
    return appendMdOutput(out, {
      name: 'chapter-map',
      subdir: 'schema',
      filename: 'chapter-map.json',
      content: serializeChapterMap(plan.map),
    })
  },
})
