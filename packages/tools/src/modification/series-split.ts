import { defineTool, registry, setVariables, withItem } from '@mt/core'
import type { Exchange, Splitter, ToolContext } from '@mt/core'
import { SERIES_SPLIT_PARTS } from '../constants.js'
import {
  type ChapterDoc,
  type ChapterDocParagraph,
  readChapterDoc,
  writeChapterDoc,
} from './chapter-doc.js'

export interface SeriesSplitOptions {
  /** Number of parts to produce when the split condition passes. */
  parts?: number
  /**
   * Override the default "chapter is large enough" check. Returning true bypasses the
   * size gate; returning false always leaves the original markdown intact.
   */
  shouldSplit?: (doc: ChapterDoc) => boolean
}

interface SeriesSplitResult {
  parts: string[]
  split: boolean
  series?: string
}

interface TextUnit {
  text: string
  paragraphIndex: number
  lineIndex: number
}

function resolveParts(value: number | undefined): number {
  const parts = value ?? SERIES_SPLIT_PARTS
  return Number.isFinite(parts) && parts > 1 ? Math.floor(parts) : 0
}

function visibleParagraphs(doc: ChapterDoc): ChapterDocParagraph[] {
  return doc.body
    .map((paragraph) => ({
      lines: paragraph.lines.filter((line) => line.trim().length > 0),
    }))
    .filter((paragraph) => paragraph.lines.length > 0)
}

function countLines(paragraphs: readonly ChapterDocParagraph[]): number {
  return paragraphs.reduce((sum, paragraph) => sum + paragraph.lines.length, 0)
}

function defaultShouldSplit(doc: ChapterDoc, parts: number): boolean {
  return parts > 1 && countLines(visibleParagraphs(doc)) >= parts
}

function paragraphWeight(paragraph: ChapterDocParagraph): number {
  return paragraph.lines.reduce((sum, line) => sum + line.length + 1, 0)
}

/**
 * Split ordered units into exactly `count` non-empty contiguous groups (or one group per
 * unit when there are fewer units than requested), balancing weight while preserving order.
 */
function partitionWeighted<T>(
  units: readonly T[],
  count: number,
  weigh: (unit: T) => number,
): T[][] {
  if (units.length === 0) return []
  if (count <= 1) return [Array.from(units)]

  const groupCount = Math.min(count, units.length)
  const groups: T[][] = []
  let index = 0
  let remainingWeight = units.reduce((sum, unit) => sum + weigh(unit), 0)

  for (let groupIndex = 0; groupIndex < groupCount; groupIndex++) {
    const groupsLeft = groupCount - groupIndex
    const maxEnd = units.length - (groupsLeft - 1)
    const target = remainingWeight / groupsLeft

    const first = units[index]
    if (first === undefined) break
    let end = index + 1
    let weight = weigh(first)

    while (end < maxEnd) {
      const next = units[end]
      if (next === undefined || weight >= target) break
      weight += weigh(next)
      end += 1
    }

    groups.push(units.slice(index, end))
    remainingWeight -= weight
    index = end
  }

  return groups
}

function lineUnits(paragraphs: readonly ChapterDocParagraph[]): TextUnit[] {
  const units: TextUnit[] = []
  paragraphs.forEach((paragraph, paragraphIndex) => {
    paragraph.lines.forEach((text, lineIndex) => {
      units.push({ text, paragraphIndex, lineIndex })
    })
  })
  return units
}

function wordUnits(paragraphs: readonly ChapterDocParagraph[]): TextUnit[] {
  const units: TextUnit[] = []
  paragraphs.forEach((paragraph, paragraphIndex) => {
    paragraph.lines.forEach((line, lineIndex) => {
      for (const text of line.trim().split(/\s+/)) {
        if (text.length > 0) units.push({ text, paragraphIndex, lineIndex })
      }
    })
  })
  return units
}

function unitsToParagraphs(units: readonly TextUnit[], joinLines: boolean): ChapterDocParagraph[] {
  const paragraphs: ChapterDocParagraph[] = []
  let current: ChapterDocParagraph | undefined
  let currentParagraphIndex: number | undefined
  let currentLineIndex: number | undefined
  let currentLine: string[] = []

  const flushLine = (): void => {
    if (current !== undefined && currentLine.length > 0) {
      current.lines.push(joinLines ? currentLine.join(' ') : (currentLine[0] ?? ''))
      currentLine = []
    }
  }

  for (const unit of units) {
    if (current === undefined || currentParagraphIndex !== unit.paragraphIndex) {
      flushLine()
      current = { lines: [] }
      paragraphs.push(current)
      currentParagraphIndex = unit.paragraphIndex
      currentLineIndex = undefined
    }
    if (currentLineIndex !== unit.lineIndex) {
      flushLine()
      currentLineIndex = unit.lineIndex
    }
    currentLine.push(unit.text)
  }
  flushLine()

  return paragraphs
}

function partitionBody(doc: ChapterDoc, count: number): ChapterDocParagraph[][] {
  const paragraphs = visibleParagraphs(doc)
  if (paragraphs.length === 0) return []

  // Prefer whole paragraphs when there are enough of them: no paragraph is cut.
  if (paragraphs.length >= count) {
    return partitionWeighted(paragraphs, count, paragraphWeight).map((group) =>
      group.map((paragraph) => ({ lines: [...paragraph.lines] })),
    )
  }

  // Not enough paragraphs for the requested part count: split at line boundaries,
  // regrouping adjacent lines that came from the same source paragraph.
  const lines = lineUnits(paragraphs)
  if (lines.length >= count) {
    return partitionWeighted(lines, count, (unit) => unit.text.length + 1).map((units) =>
      unitsToParagraphs(units, false),
    )
  }

  // A custom `shouldSplit` may force more parts than there are lines. Fall back to
  // word boundaries so the requested part count is still respected when possible.
  const words = wordUnits(paragraphs)
  const groupCount = Math.min(count, words.length)
  if (groupCount <= 1) return [paragraphs.map((paragraph) => ({ lines: [...paragraph.lines] }))]

  return partitionWeighted(words, groupCount, (unit) => unit.text.length + 1).map((units) =>
    unitsToParagraphs(units, true),
  )
}

async function splitSeriesMarkdown(
  markdown: string,
  options: SeriesSplitOptions,
): Promise<SeriesSplitResult> {
  const doc = readChapterDoc(markdown)
  const parts = resolveParts(options.parts)
  const shouldSplit = options.shouldSplit ?? ((candidate) => defaultShouldSplit(candidate, parts))

  if (parts < 2 || !shouldSplit(doc)) {
    return { parts: [markdown], split: false }
  }

  const bodyParts = partitionBody(doc, parts)
  if (bodyParts.length < 2) {
    return { parts: [markdown], split: false }
  }

  const series = doc.series ?? doc.title
  const output = await Promise.all(
    bodyParts.map((body, index) =>
      writeChapterDoc({
        title: `${doc.title} ${index + 1}`,
        number: doc.number,
        series,
        warnings: doc.warnings.map((warning) => ({ ...warning })),
        body,
      }),
    ),
  )

  return { parts: output, split: true, series }
}

function textItem(env: Exchange<unknown>): string {
  if (typeof env.item !== 'string') {
    throw new Error('seriesSplitter: item must be a string')
  }
  return env.item
}

/**
 * Create the chapter-document → series-parts splitter used by `.subflow('series')`.
 *
 * The source markdown is parsed with `readChapterDoc`; each part is rebuilt as a new
 * `ChapterDoc` with a numbered title and `series` frontmatter, then serialized with
 * `writeChapterDoc`. Chapters that do not pass the split condition are returned unchanged
 * as a single item.
 */
export function createSeriesSplitter(options: SeriesSplitOptions = {}): Splitter<string> {
  return {
    name: 'series-splitter',
    async split(env) {
      const result = await splitSeriesMarkdown(textItem(env), options)
      return result.parts
    },
  }
}

export const seriesSplitter = createSeriesSplitter()

/**
 * Backward-compatible tool form. Reuses the splitter logic and records `series` +
 * `partCount` variables only when a split actually happened.
 */
export function createSeriesSplitTool(options: SeriesSplitOptions = {}) {
  return defineTool<string, string[]>({
    name: 'series-split',
    version: '1.0.0',
    mdDescription:
      'Split a large chapter document into numbered series parts with series frontmatter.',
    async invoke(env: Exchange<string>, _ctx: ToolContext): Promise<Exchange<string[]>> {
      const result = await splitSeriesMarkdown(textItem(env), options)
      const output = withItem(env, result.parts)
      if (!result.split || result.series === undefined) return output
      return setVariables(output, {
        series: result.series,
        partCount: result.parts.length,
      })
    },
  })
}

export const seriesSplitTool = createSeriesSplitTool()

registry.registerSplitter('series', seriesSplitter)
