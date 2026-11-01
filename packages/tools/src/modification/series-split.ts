import { defineTool, registry, setVariables, withItem } from '@mt/core'
import type { Exchange, Splitter, ToolContext } from '@mt/core'
import { SERIES_SPLIT_TARGET_CHARS } from '../constants.js'
import { splitParagraphUnits, splitReadableParts } from '../normalization/token-splitter.js'
import {
  type ChapterDoc,
  type ChapterDocParagraph,
  readChapterDoc,
  writeChapterDoc,
} from './chapter-doc.js'

export interface SeriesSplitOptions {
  /**
   * Number of parts to produce when the chapter passes the split condition. Omit to use the
   * balanced strategy (SERIES_SPLIT_STRATEGY 'balanced'): only chapters whose meaningful
   * body exceeds `targetChars` are split, into parts of approximately `targetChars` each.
   */
  parts?: number
  /**
   * Balanced-strategy target: meaningful body size in characters per part
   * (default SERIES_SPLIT_TARGET_CHARS). Chapters at or below the target stay whole.
   */
  targetChars?: number
  /**
   * Override the default readability gate. Returning false always leaves the original
   * markdown intact; returning true still cannot cut a sentence, so the result may contain
   * fewer parts when the chapter is too short.
   */
  shouldSplit?: (doc: ChapterDoc) => boolean
}

interface SeriesSplitResult {
  parts: string[]
  split: boolean
  series?: string
}

/**
 * Balanced default: split only bodies larger than the target, into
 * ceil(bodyChars / target) parts of approximately equal size. An explicit
 * `parts` option keeps the fixed-part-count behavior.
 */
function resolveParts(bodyChars: number, options: SeriesSplitOptions): number {
  if (options.parts !== undefined) {
    const parts = options.parts
    return Number.isFinite(parts) && parts > 1 ? Math.floor(parts) : 0
  }
  const target = options.targetChars ?? SERIES_SPLIT_TARGET_CHARS
  if (!Number.isFinite(target) || target < 1 || bodyChars <= target) return 0
  return Math.max(2, Math.ceil(bodyChars / target))
}

function isDecorativeLine(line: string): boolean {
  return /^[-*_=~]{3,}$/.test(line.trim())
}

function meaningfulBody(doc: ChapterDoc): ChapterDocParagraph[] {
  return doc.body
    .map((paragraph) => ({
      lines: paragraph.lines.filter((line) => line.trim().length > 0 && !isDecorativeLine(line)),
    }))
    .filter((paragraph) => paragraph.lines.length > 0)
}

function chapterBody(doc: ChapterDoc): string {
  return meaningfulBody(doc)
    .map((paragraph) => paragraph.lines.join('\n'))
    .join('\n\n')
}

function bodyParagraphs(text: string): ChapterDocParagraph[] {
  return splitParagraphUnits(text)
    .map((block) => ({
      lines: block
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0),
    }))
    .filter((paragraph) => paragraph.lines.length > 0)
}

async function splitSeriesMarkdown(
  markdown: string,
  options: SeriesSplitOptions,
): Promise<SeriesSplitResult> {
  const doc = readChapterDoc(markdown)
  const body = chapterBody(doc)
  const parts = resolveParts(body.length, options)
  if (parts < 2 || (options.shouldSplit && !options.shouldSplit(doc))) {
    return { parts: [markdown], split: false }
  }

  // Paragraph-first, sentence-safe partition from token-splitter (balanced: each part gets
  // approximately body.length / parts characters). The last sentence of a piece always
  // stays whole, and whole paragraphs are preferred when there are enough.
  const bodyParts = splitReadableParts(body, parts)
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
        body: bodyParagraphs(body),
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
 * Create the chapter-document → series-parts splitter used by `.subflow('series://')` /
 * `.subflow('#series')`.
 *
 * The source markdown is parsed with `readChapterDoc`; each part is rebuilt as a new
 * `ChapterDoc` with a numbered title and `series` frontmatter, then serialized with
 * `writeChapterDoc`. The partition is paragraph-first and sentence-safe (delegated to
 * `splitReadableParts` in token-splitter), so a sentence is never cut in half. Chapters that
 * do not pass the condition are returned unchanged as a single item.
 *
 * Default condition (balanced strategy): the meaningful body must exceed
 * `targetChars` (default SERIES_SPLIT_TARGET_CHARS), and the part count is derived as
 * `ceil(bodyChars / targetChars)` so the parts are approximately equal in size. Pass an
 * explicit `parts` to split into a fixed number of parts instead.
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
