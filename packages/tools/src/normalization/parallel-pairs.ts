import { createHash } from 'node:crypto'
import { category, defineTool, tool, withItem, withMeta } from '@mt/core'
import type { Exchange, ToolContext } from '@mt/core'
import { errorMessage } from '../core/values.js'

/**
 * Turns a chapter-aligned `{ en, ru }` document into parallel training pairs (TL255).
 *
 * Both sides are split on blank lines into paragraph blocks. Empty blocks, the leading YAML
 * frontmatter block, heading-only blocks and decorative separator blocks (`---`, `***`, `___`)
 * are dropped from each side independently, because they carry no aligned prose and would
 * shift the paragraphs against each other. What remains is paired by position; the share of
 * alignable paragraphs is `min(en, ru) / max(en, ru)` and a share below
 * {@link MIN_PARALLEL_ALIGNMENT} throws a retryable {@link ParallelPairsError} (the chapter was
 * split differently on one side, so pairing by position would teach wrong translations).
 *
 * Output is JSONL of `{ id, src, tgt, chars, ratio }`: `id` is a stable 12-hex-character sha1
 * prefix over `src` + `tgt`, `chars` is the pair's combined character count and `ratio` is
 * `tgt.length / src.length` rounded to three decimals.
 */

/** Minimum share of paragraphs that must pair 1:1 before the tool gives up. */
export const MIN_PARALLEL_ALIGNMENT = 0.6

/** Id prefix length (hex characters of the sha1 digest). */
const ID_LENGTH = 12

/** A chapter pair: markdown of the same chapter in both languages. */
export interface ParallelChapter {
  en: string
  ru: string
}

/** One aligned paragraph pair. */
export interface ParallelPair {
  id: string
  src: string
  tgt: string
  /** `src.length + tgt.length`. */
  chars: number
  /** `tgt.length / src.length`, 3 decimals. */
  ratio: number
}

/** Paragraphs dropped from one side before alignment. */
export interface ParagraphDropStats {
  empty: number
  heading: number
  frontmatter: number
}

/** Result of splitting one side of the chapter. */
export interface ParagraphSplit {
  paragraphs: string[]
  dropped: ParagraphDropStats
}

/** Envelope metadata written by the tool. */
export interface ParallelPairsStats {
  pairs: number
  aligned: number
  paragraphsEn: number
  paragraphsRu: number
  alignmentShare: number
  droppedEn: ParagraphDropStats
  droppedRu: ParagraphDropStats
}

/** Result of the pure conversion. */
export interface ParallelPairsResult {
  jsonl: string
  pairs: ParallelPair[]
  stats: ParallelPairsStats
}

/**
 * Raised when the two sides cannot be paired: fewer than
 * {@link MIN_PARALLEL_ALIGNMENT} of the paragraphs line up. Retryable, so a pipeline that
 * re-translates on failure gets another attempt.
 */
export class ParallelPairsError extends Error {
  readonly retryable = true

  constructor(
    readonly share: number,
    readonly enParagraphs: number,
    readonly ruParagraphs: number,
  ) {
    super(
      `parallel-pairs: only ${(share * 100).toFixed(1)}% of paragraphs align (en ${enParagraphs}, ru ${ruParagraphs}, minimum ${(MIN_PARALLEL_ALIGNMENT * 100).toFixed(0)}%); keep the same paragraph breaks on both sides (drop stray headings on one side only, or re-split the chapter) before exporting pairs`,
    )
    this.name = 'ParallelPairsError'
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** A decorative-only line (`---`, `***`, `___`, …) that never carries prose. */
function isDecorative(line: string): boolean {
  return /^([-*_])\1{2,}$/.test(line.replace(/\s+/g, ''))
}

/** True when every non-empty line is a markdown heading or a decorative separator. */
function isHeadingOnly(block: string): boolean {
  const lines = block
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
  if (lines.length === 0) return false
  return lines.every((line) => /^#{1,6}\s/.test(line) || isDecorative(line))
}

/** True for a leading `---` … `---` YAML frontmatter block. */
function isFrontmatterBlock(block: string): boolean {
  const lines = block.split('\n').map((line) => line.trim())
  return lines.length >= 2 && lines[0] === '---' && lines[lines.length - 1] === '---'
}

/**
 * Splits markdown into paragraph blocks on blank lines, dropping empty blocks, the leading
 * frontmatter block, heading-only blocks and decorative-only blocks. Exported for reuse/tests.
 */
export function splitParagraphs(markdown: string): ParagraphSplit {
  const blocks = markdown.split(/\n[ \t]*\n/)
  const paragraphs: string[] = []
  const dropped: ParagraphDropStats = { empty: 0, heading: 0, frontmatter: 0 }

  for (const [index, block] of blocks.entries()) {
    const text = block.trim()
    if (text === '') {
      // a trailing newline produces one artefact block; it is not a dropped paragraph
      if (index < blocks.length - 1) dropped.empty += 1
      continue
    }
    if (index === 0 && isFrontmatterBlock(text)) {
      dropped.frontmatter += 1
      continue
    }
    if (isHeadingOnly(text)) {
      dropped.heading += 1
      continue
    }
    paragraphs.push(text)
  }

  return { paragraphs, dropped }
}

/** Reads `{ en, ru }` from a parsed object item or a JSON string item. */
function readChapter(item: ParallelChapter | string): ParallelChapter {
  if (typeof item !== 'string') {
    if (isRecord(item) && typeof item.en === 'string' && typeof item.ru === 'string') {
      return { en: item.en, ru: item.ru }
    }
    throw new Error(
      'parallel-pairs: item must be `{ en, ru }` chapter markdown (or a JSON string of that object); ' +
        'feed this tool one chapter at a time',
    )
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(item)
  } catch (error) {
    throw new Error(
      `parallel-pairs: item is not valid JSON (${errorMessage(error)}); pass \`{ "en": "...", "ru": "..." }\` or a pre-parsed object`,
    )
  }
  if (!isRecord(parsed) || typeof parsed.en !== 'string' || typeof parsed.ru !== 'string') {
    throw new Error(
      'parallel-pairs: JSON item must be an object with string `en` and `ru` chapter markdown',
    )
  }
  return { en: parsed.en, ru: parsed.ru }
}

/** Stable 12-hex sha1 prefix over the pair text. */
export function pairId(src: string, tgt: string): string {
  return createHash('sha1').update(`${src}\n${tgt}`).digest('hex').slice(0, ID_LENGTH)
}

function pairOf(src: string, tgt: string): ParallelPair {
  const ratio = Math.round((tgt.length / src.length) * 1000) / 1000
  return { id: pairId(src, tgt), src, tgt, chars: src.length + tgt.length, ratio }
}

function jsonlOf(pairs: ParallelPair[]): string {
  return pairs.length === 0 ? '' : `${pairs.map((pair) => JSON.stringify(pair)).join('\n')}\n`
}

/**
 * Pure conversion: `{ en, ru }` markdown -> aligned pairs. Throws a retryable
 * {@link ParallelPairsError} when fewer than 60% of the paragraphs align.
 */
export function buildParallelPairs(chapter: ParallelChapter): ParallelPairsResult {
  const en = splitParagraphs(chapter.en)
  const ru = splitParagraphs(chapter.ru)
  const aligned = Math.min(en.paragraphs.length, ru.paragraphs.length)
  const total = Math.max(en.paragraphs.length, ru.paragraphs.length)
  const share = total === 0 ? 0 : aligned / total

  if (share < MIN_PARALLEL_ALIGNMENT) {
    throw new ParallelPairsError(share, en.paragraphs.length, ru.paragraphs.length)
  }

  const pairs: ParallelPair[] = []
  for (let i = 0; i < aligned; i += 1) {
    const src = en.paragraphs[i]
    const tgt = ru.paragraphs[i]
    if (src === undefined || tgt === undefined) {
      throw new Error(`parallel-pairs: missing paragraph at index ${i} after alignment`)
    }
    pairs.push(pairOf(src, tgt))
  }

  return {
    jsonl: jsonlOf(pairs),
    pairs,
    stats: {
      pairs: pairs.length,
      aligned,
      paragraphsEn: en.paragraphs.length,
      paragraphsRu: ru.paragraphs.length,
      alignmentShare: Math.round(share * 1000) / 1000,
      droppedEn: en.dropped,
      droppedRu: ru.dropped,
    },
  }
}

/**
 * Exports paragraph-aligned EN/RU pairs from a `{ en, ru }` chapter document as JSONL of
 * `{ id, src, tgt, chars, ratio }` with stable sha1-prefix ids. Throws a retryable error when
 * fewer than 60% of the paragraphs on the two sides pair 1:1.
 */
export const parallelPairs = defineTool<ParallelChapter | string, string>({
  name: 'parallel-pairs',
  version: '1.0.0',
  mdDescription:
    'Splits `{ en, ru }` chapter markdown into paragraphs, drops empty/heading-only blocks and emits JSONL aligned pairs `{ id, src, tgt, chars, ratio }`; retryable error below 60% alignment.',
  annotations: [
    tool('TL255', {
      name: 'parallel-pairs',
      description: 'Emits paragraph-aligned EN/RU pairs as JSONL with stable sha1-prefix ids.',
      refs: [],
    }),
    category(['extractor']),
  ],
  async invoke(
    env: Exchange<ParallelChapter | string>,
    _ctx: ToolContext,
  ): Promise<Exchange<string>> {
    const { jsonl, stats } = buildParallelPairs(readChapter(env.item))
    return withMeta(withItem(env, jsonl), { ...stats })
  },
})
