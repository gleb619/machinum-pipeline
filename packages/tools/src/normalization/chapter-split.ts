import { existsSync, readFileSync } from 'node:fs'
import {
  batchMembersOf,
  category,
  defineTool,
  getVariable,
  setVariable,
  tool,
  withItem,
} from '@mt/core'
import type { Exchange, ToolContext } from '@mt/core'
import { appendMdOutput } from '../core/md-outputs.js'
import type { StatsArtifact } from './chapter-stats.js'
import { createSeriesSplitTool } from './text-splitter.js'

/**
 * Split oversized chapters and give every part a stable book-wide sequential id.
 *
 * The series splitter keeps the source chapter number on every part. The aggregation stage
 * renumbers the whole book 1..N and records the mapping in `schema/chapter-map.json`.
 * Identity case: when nothing is oversized no chapter files are written and downstream keeps
 * reading the source directory.
 */

export function readStats(path: string): StatsArtifact {
  const stats = JSON.parse(readFileSync(path, 'utf-8')) as StatsArtifact
  if (!Number.isFinite(stats.book?.threshold)) {
    throw new Error(`split: ${path} has no numeric book.threshold - run the stats stage first`)
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

export interface SplitChapterToolOptions {
  /** Stats artefact path, resolved lazily at the first invoke (string or thunk). */
  statsPath: string | (() => string)
}

/**
 * Per-chapter stage: run the series splitter pinned to the book threshold and record
 * `{ orig, title, parts }`.
 */
export function createSplitChapterTool(options: SplitChapterToolOptions) {
  const resolveStatsPath = (): string =>
    typeof options.statsPath === 'function' ? options.statsPath() : options.statsPath
  let cachedSplitter: ReturnType<typeof createSeriesSplitTool> | undefined
  const splitter = (): ReturnType<typeof createSeriesSplitTool> => {
    cachedSplitter ??= createSeriesSplitTool({
      targetChars: Math.floor(readStats(resolveStatsPath()).book.threshold),
    })
    return cachedSplitter
  }

  return defineTool<string, string[]>({
    name: 'split-chapter',
    version: '1.0.0',
    description:
      'Splits a chapter larger than the book threshold into series parts and records the split unit.',
    annotations: [
      tool('TL264', {
        name: 'split-chapter',
        description: 'Splits one oversized chapter into series parts.',
        refs: ['UC056'],
      }),
      category(['splitter']),
    ],
    async invoke(env: Exchange<string>, ctx: ToolContext): Promise<Exchange<string[]>> {
      const orig = Number(env.meta.chapterNum ?? 0)
      const title = headingOf(env.item)
      const split = await splitter().invoke(env, ctx)
      const parts = split.item.map(String)
      return setVariable(withItem(env, parts), VAR_SPLIT_UNIT, { orig, title, parts })
    },
  })
}

/**
 * Aggregation stage: renumber the book and emit `schema/chapter-map.json` (plus
 * `split/chapter<id>.md` only when at least one chapter was split).
 */
export const writeSplitOutputs = defineTool<unknown, unknown>({
  name: 'write-split-outputs',
  version: '1.0.0',
  description:
    'Renumbers the book sequentially and emits chapter-map.json; emits split/chapter<id>.md when a chapter was split.',
  annotations: [
    tool('TL265', {
      name: 'write-split-outputs',
      description: 'Renumbers split chapters and emits the book chapter map.',
      refs: ['UC056'],
    }),
    category(['serializer']),
  ],
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

/** Reads a `chapter-map.json` file; `undefined` when absent or invalid. */
export function readChapterMap(path: string): ChapterMap | undefined {
  if (!existsSync(path)) return undefined
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as ChapterMap
  } catch {
    return undefined
  }
}

/** True when the split stage wrote renumbered parts (any source chapter became >1 part). */
export function splitProduced(map: ChapterMap | undefined): boolean {
  if (!map) return false
  return Object.values(map).some((entry) => entry.of > 1)
}
