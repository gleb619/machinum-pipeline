import { defineTool, setVariables, withItem, withMeta } from '@mt/core'
import type { Exchange, ToolContext } from '@mt/core'
import { readCtx } from '../core/llm-config.js'
import { cleanSource } from './text-normalizer.js'
import { DEFAULT_CHUNK_TARGET, type TokenCountFn, heuristicTokenCount } from './token-splitter.js'

/** Default separator line placed between fixated chunks. */
export const DEFAULT_CHUNK_SEPARATOR = '---'

/** Variable with the number of separator-delimited chunks in the result text. */
export const VAR_CHUNK_COUNT = 'chunkCount'
/** Variable with the separator line used between chunks. */
export const VAR_CHUNK_SEPARATOR = 'chunkSeparator'

/** A line made only of decorative characters (mirrors text-normalizer `DECORATIVE_LINE`). */
const DECORATIVE_LINE = /^[\s*~=_\-#+•·■-◿★☆※♦—–.]{3,}$/

/** True when the line is exactly the separator (surrounding whitespace ignored). */
function isSeparatorLine(line: string, separator: string): boolean {
  return line.trim() === separator
}

/** True when the text contains at least one separator line. */
function hasSeparators(text: string, separator: string): boolean {
  return text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .some((line) => isSeparatorLine(line, separator))
}

/**
 * Remove every line that is only the separator, plus other decorative-only lines
 * (`***`, `~~~`, `___`, ...), and collapse the blank-line runs left behind.
 */
export function stripSeparators(text: string, separator = DEFAULT_CHUNK_SEPARATOR): string {
  const lines = text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .filter((line) => !isSeparatorLine(line, separator) && !DECORATIVE_LINE.test(line))

  const out: string[] = []
  for (const line of lines) {
    if (line.trim() === '' && (out.length === 0 || out.at(-1)?.trim() === '')) continue
    out.push(line)
  }
  while (out.at(-1)?.trim() === '') out.pop()
  return out.join('\n')
}

/**
 * Greedy-pack units into token-bounded chunks joined by `join`. Units are never split;
 * the joined text is re-measured so the delimiter cannot push a chunk over budget.
 */
function packUnits(
  units: string[],
  targetTokens: number,
  count: TokenCountFn,
  join: string,
): string[] {
  const chunks: string[] = []
  let current = ''

  for (const unit of units) {
    const next = current ? `${current}${join}${unit}` : unit
    if (current && count(next) > targetTokens) {
      chunks.push(current)
      current = unit
    } else {
      current = next
    }
  }

  if (current.trim()) chunks.push(current)
  return chunks
}

/**
 * Split an over-budget paragraph at line boundaries; a line that is still over budget
 * falls back to whole-word chunks (never cut mid-word).
 */
function splitLongParagraph(
  paragraph: string,
  targetTokens: number,
  count: TokenCountFn,
): string[] {
  const lines = paragraph
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)

  const pieces: string[] = []
  for (const line of lines) {
    if (count(line) <= targetTokens) {
      pieces.push(line)
    } else {
      const words = line.split(/\s+/).filter((word) => word.length > 0)
      pieces.push(...packUnits(words, targetTokens, count, ' '))
    }
  }
  return packUnits(pieces, targetTokens, count, '\n')
}

export interface SplitIntoChunksOptions {
  /** Max tokens per chunk. Default {@link DEFAULT_CHUNK_TARGET}. */
  targetTokens?: number
  /** Token counter. Default {@link heuristicTokenCount}. */
  count?: TokenCountFn
}

/**
 * Clean text (strip separators, collapse blank runs), then split into chunks of at most
 * `targetTokens` each. Paragraph boundaries are preferred, line boundaries next, and a
 * single over-long line is split at word boundaries. Text is never lost, reordered, or
 * cut mid-word; an empty result means the cleaned input was empty.
 */
export function splitIntoChunks(text: string, options: SplitIntoChunksOptions = {}): string[] {
  const { targetTokens = DEFAULT_CHUNK_TARGET, count = heuristicTokenCount } = options
  const cleaned = cleanSource(stripSeparators(text))
  if (!cleaned.trim()) return []
  if (count(cleaned) <= targetTokens) return [cleaned]

  const units: string[] = []
  for (const paragraph of cleaned.split(/\n\n+/).filter((part) => part.trim())) {
    if (count(paragraph) <= targetTokens) {
      units.push(paragraph)
    } else {
      units.push(...splitLongParagraph(paragraph, targetTokens, count))
    }
  }
  return packUnits(units, targetTokens, count, '\n\n')
}

/** Join chunks into one fixated text: `chunkA\n\n---\n\nchunkB...`. */
export function joinChunks(chunks: string[], separator = DEFAULT_CHUNK_SEPARATOR): string {
  return chunks
    .map((chunk) => chunk.trim())
    .filter((chunk) => chunk.length > 0)
    .join(`\n\n${separator}\n\n`)
}

/**
 * Inverse of {@link joinChunks}: split fixated text on separator lines and return the
 * chunks as-is (trimmed, empty chunks dropped). Text without separator lines parses to
 * a single chunk (or none when empty).
 */
export function parseChunks(text: string, separator = DEFAULT_CHUNK_SEPARATOR): string[] {
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  const chunks: string[] = []
  let current: string[] = []

  const flush = (): void => {
    const chunk = current.join('\n').trim()
    if (chunk) chunks.push(chunk)
    current = []
  }

  for (const line of lines) {
    if (isSeparatorLine(line, separator)) {
      flush()
    } else {
      current.push(line)
    }
  }
  flush()
  return chunks
}

function toPositiveInt(value: unknown): number | undefined {
  let n: number
  if (typeof value === 'number') {
    n = value
  } else if (typeof value === 'string') {
    n = Number(value.trim())
  } else {
    return undefined
  }
  if (!Number.isFinite(n) || n <= 0) return undefined
  return Math.floor(n)
}

export interface ChunkSizeOptions {
  /** Chunk size in tokens (tool option layer). */
  chunkSize?: number
}

/**
 * Resolve the chunk size in tokens. First defined wins:
 * `env.meta.chunkSize` → tool option `chunkSize` → mt.json `settings.chunkSize` →
 * `MT_CHUNK_SIZE` env → {@link DEFAULT_CHUNK_TARGET}.
 */
export function resolveChunkSize(
  env: Pick<Exchange, 'meta'>,
  ctx?: ToolContext,
  opts?: ChunkSizeOptions,
): number {
  const fromMeta = toPositiveInt(env.meta.chunkSize)
  if (fromMeta !== undefined) return fromMeta
  const fromOption = toPositiveInt(opts?.chunkSize)
  if (fromOption !== undefined) return fromOption
  const view = readCtx(ctx)
  const fromSettings = toPositiveInt(view.settings.chunkSize)
  if (fromSettings !== undefined) return fromSettings
  const fromEnv = toPositiveInt(view.env.MT_CHUNK_SIZE)
  if (fromEnv !== undefined) return fromEnv
  return DEFAULT_CHUNK_TARGET
}

export interface ChunkCleanOptions {
  /** Separator line to strip. Default `---`. */
  separator?: string
}

/** Create a chunk-clean tool with a fixed separator. */
export function createChunkClean(options: ChunkCleanOptions = {}) {
  const separator = options.separator ?? DEFAULT_CHUNK_SEPARATOR
  return defineTool<string, string>({
    name: 'chunk-clean',
    version: '1.0.0',
    mdDescription:
      "Strip chunk separator lines ('---' by default) and other decorative-only lines from fixated text, collapsing the blank runs left behind. Sets `chunkCount` (meta + variable, separator-delimited chunks in the result text) and the `chunkSeparator` variable.",
    async invoke(env: Exchange<string>, _ctx: ToolContext): Promise<Exchange<string>> {
      const output = stripSeparators(env.item, separator)
      const chunkCount = parseChunks(output, separator).length
      return withMeta(
        setVariables(withItem(env, output), {
          [VAR_CHUNK_COUNT]: chunkCount,
          [VAR_CHUNK_SEPARATOR]: separator,
        }),
        { chunkCount },
      )
    },
  })
}

/** Default chunk-clean tool. */
export const chunkClean = createChunkClean()

export interface ChunkSplitOptions extends ChunkSizeOptions {
  /** Separator line written between chunks. Default `---`. */
  separator?: string
  /** Reuse existing separator lines instead of re-splitting. Default: true. */
  reuse?: boolean
  /** Token counter. Default {@link heuristicTokenCount}. */
  count?: TokenCountFn
}

/** Create a chunk-split tool with fixed options. */
export function createChunkSplit(options: ChunkSplitOptions = {}) {
  const separator = options.separator ?? DEFAULT_CHUNK_SEPARATOR
  const reuse = options.reuse ?? true
  const count = options.count ?? heuristicTokenCount
  return defineTool<string, string>({
    name: 'chunk-split',
    version: '1.0.0',
    mdDescription:
      "Clean text and split it into token-bounded chunks fixated by separator lines ('---' by default). Chunk size resolution: `meta.chunkSize` → tool option `chunkSize` → mt.json `settings.chunkSize` → `MT_CHUNK_SIZE` → 6000. With `reuse` (default true) text that already contains separator lines is kept as-is, so later runs never re-split fixated chunks. Sets `chunkCount` (meta + variable) and the `chunkSeparator` variable.",
    async invoke(env: Exchange<string>, ctx: ToolContext): Promise<Exchange<string>> {
      const input = env.item
      let output: string
      if (reuse && hasSeparators(input, separator)) {
        output = input
      } else {
        const targetTokens = resolveChunkSize(env, ctx, options)
        output = joinChunks(splitIntoChunks(input, { targetTokens, count }), separator)
      }
      const chunkCount = parseChunks(output, separator).length
      return withMeta(
        setVariables(withItem(env, output), {
          [VAR_CHUNK_COUNT]: chunkCount,
          [VAR_CHUNK_SEPARATOR]: separator,
        }),
        { chunkCount },
      )
    },
  })
}

/** Default chunk-split tool. */
export const chunkSplit = createChunkSplit()
