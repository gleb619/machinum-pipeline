import { category, defineTool, registry, setVariables, tool, useCase, withItem } from '@mt/core'
import type { Exchange, Splitter, SplitterContext, Tool, ToolContext } from '@mt/core'
import {
  type TokenCountFn,
  type TokenSplitStrategy,
  heuristicTokenCount,
  paragraphStrategy,
  splitReadableParts,
} from '@mt/core'
import { DEFAULT_MAX_TOKENS, SERIES_SPLIT_TARGET_CHARS } from '../constants.js'
import {
  type ChapterDoc,
  type ChapterDocNode,
  readChapterDoc,
  writeChapterDoc,
} from '../modification/chapter-doc.js'
import { resolveTunedNum } from '../resolve-constants.js'

export {
  DEFAULT_CHUNK_TARGET,
  type BalancedLineStrategyOptions,
  type BalancedStrategyOptions,
  type LineStrategyOptions,
  type ParagraphStrategyOptions,
  type SentenceStrategyOptions,
  type TokenCountFn,
  type TokenSplitStrategy,
  type WhitespaceStrategyOptions,
  balanceText,
  balancedLineStrategy,
  balancedStrategy,
  heuristicTokenCount,
  lineStrategy,
  overlap,
  paragraphStrategy,
  rebalance,
  rebalanceLines,
  sentenceStrategy,
  singleStrategy,
  splitLineUnits,
  splitParagraphUnits,
  splitReadableParts,
  splitSentenceUnits,
  whitespaceStrategy,
} from '@mt/core'
export { DEFAULT_MAX_TOKENS } from '../constants.js'

/**
 * Count tokens using gpt-tokenizer if available, otherwise use heuristic.
 */
export async function countTokens(text: string): Promise<number> {
  try {
    const { encode } = await import('gpt-tokenizer')
    return encode(text).length
  } catch {
    return heuristicTokenCount(text)
  }
}

export interface TokenSplitterOptions {
  strategy: TokenSplitStrategy
  maxTokens?: number
}

export interface TokenSplitter extends Tool<string, string[]> {
  with(overrides: Partial<TokenSplitterOptions>): TokenSplitter
}

export function createTokenSplitter(options: Partial<TokenSplitterOptions> = {}): TokenSplitter {
  const maxTokens = options.maxTokens
  const strategy = options.strategy ?? paragraphStrategy()

  const base = defineTool<string, string[]>({
    name: 'token-splitter',
    version: '1.0.0',
    mdDescription:
      'Splits text into chunks using a pluggable TokenSplitStrategy. Default strategy splits at paragraph boundaries respecting a token limit.',
    annotations: [
      tool('TL106', {
        name: 'token-splitter',
        description: 'Splits text into chunks under a token limit.',
        refs: ['UC056'],
      }),
      useCase('UC056'),
      category(['splitter']),
    ],
    async invoke(env: Exchange<string>, ctx: ToolContext): Promise<Exchange<string[]>> {
      const inputs = env.items ?? [env.item]
      const allChunks: string[] = []
      const limit = maxTokens ?? resolveTunedNum('DEFAULT_MAX_TOKENS', DEFAULT_MAX_TOKENS, env, ctx)

      for (const input of inputs) {
        const tokenCount = await countTokens(input)
        if (tokenCount <= limit) {
          allChunks.push(input)
        } else {
          const chunks = await strategy.split(input)
          for (const chunk of chunks) {
            allChunks.push(chunk)
          }
        }
      }

      return setVariables(withItem(env, allChunks), {
        split: allChunks.length > inputs.length,
        chunkCount: allChunks.length,
        strategy: strategy.name,
      })
    },
  })

  return Object.assign(base, {
    with(overrides: Partial<TokenSplitterOptions>): TokenSplitter {
      return createTokenSplitter({ maxTokens, strategy, ...overrides })
    },
  })
}

/**
 * Decorator-style helper: swap the strategy on a token splitter.
 */
export function withStrategy(tool: TokenSplitter, strategy: TokenSplitStrategy): TokenSplitter {
  if (typeof tool.with !== 'function') {
    throw new Error(`Tool '${tool.name}' does not support strategy overrides`)
  }
  return tool.with({ strategy })
}

/**
 * Default token splitter: paragraph strategy, ~12000 token upper bound.
 */
export const tokenSplitter = createTokenSplitter()

// ---------------------------------------------------------------------------
// Series split
// ---------------------------------------------------------------------------

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
function resolveParts(
  bodyChars: number,
  options: SeriesSplitOptions,
  env: Exchange<unknown>,
  ctx?: SplitterContext,
): number {
  if (options.parts !== undefined) {
    const parts = options.parts
    return Number.isFinite(parts) && parts > 1 ? Math.floor(parts) : 0
  }
  const target =
    options.targetChars ??
    resolveTunedNum(
      'SERIES_SPLIT_TARGET_CHARS',
      SERIES_SPLIT_TARGET_CHARS,
      env,
      ctx as ToolContext | undefined,
    )
  if (!Number.isFinite(target) || target < 1 || bodyChars <= target) return 0
  return Math.max(2, Math.ceil(bodyChars / target))
}

function isDecorativeLine(line: string): boolean {
  return /^[-*_=~]{3,}$/.test(line.trim())
}

function meaningfulBody(doc: ChapterDocNode): string[] {
  return doc
    .chapterTree()
    .paragraphs()
    .map((paragraph) =>
      paragraph.lines
        .map((line) => line.text)
        .filter((line) => line.trim().length > 0 && !isDecorativeLine(line))
        .join('\n'),
    )
    .filter((text) => text.length > 0)
}

function chapterBody(doc: ChapterDocNode): string {
  return meaningfulBody(doc).join('\n\n')
}

async function splitSeriesMarkdown(
  markdown: string,
  options: SeriesSplitOptions,
  env: Exchange<unknown>,
  ctx?: SplitterContext,
): Promise<SeriesSplitResult> {
  const doc = readChapterDoc(markdown)
  const body = chapterBody(doc)
  const parts = resolveParts(body.length, options, env, ctx)
  if (parts < 2 || (options.shouldSplit && !options.shouldSplit(doc))) {
    return { parts: [markdown], split: false }
  }

  // Paragraph-first, sentence-safe partition from core text-split (balanced: each part gets
  // approximately body.length / parts characters). The last sentence of a piece always
  // stays whole, and whole paragraphs are preferred when there are enough.
  const bodyParts = splitReadableParts(body, parts)
  if (bodyParts.length < 2) {
    return { parts: [markdown], split: false }
  }

  const series = doc.series ?? doc.chapter.title
  const output = await Promise.all(
    bodyParts.map((body, index) => {
      const chapter = doc.chapter.toChapter()
      chapter.title = `${doc.chapter.title} ${index + 1}`
      chapter.content = body
      return writeChapterDoc({
        number: doc.number,
        series,
        warnings: doc.warnings.map((warning) => ({ ...warning })),
        meta: doc.meta ? { ...doc.meta } : undefined,
        chapter,
      })
    }),
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
 * `splitReadableParts` in core text-split), so a sentence is never cut in half. Chapters that
 * do not pass the condition are returned unchanged as a single item.
 *
 * Default condition (balanced strategy): the meaningful body must exceed
 * `targetChars` (default `SERIES_SPLIT_TARGET_CHARS`, tunable via the `constants` chain),
 * and the part count is derived as `ceil(bodyChars / targetChars)` so the parts are
 * approximately equal in size. Pass an explicit `parts` to split into a fixed number of
 * parts instead.
 */
export function createSeriesSplitter(options: SeriesSplitOptions = {}): Splitter<string> {
  return {
    name: 'series-splitter',
    async split(env, ctx) {
      const result = await splitSeriesMarkdown(textItem(env), options, env, ctx)
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
    annotations: [
      tool('TL233', {
        name: 'series-split',
        description: 'Splits a large chapter document into numbered series parts.',
        refs: ['UC056'],
      }),
      useCase('UC056'),
      category(['splitter']),
    ],
    async invoke(env: Exchange<string>, ctx: ToolContext): Promise<Exchange<string[]>> {
      const result = await splitSeriesMarkdown(textItem(env), options, env, ctx)
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
