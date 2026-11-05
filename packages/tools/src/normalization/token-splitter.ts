import { category, defineTool, setVariables, tool, useCase, withItem, withMeta } from '@mt/core'
import type { Exchange, ToolContext, Variable } from '@mt/core'
import {
  DEFAULT_CHUNK_SEPARATOR,
  DEFAULT_CHUNK_TARGET,
  type TokenCountFn,
  hasSeparators,
  heuristicTokenCount,
  joinChunks,
  parseChunks,
  splitIntoChunks,
  stripSeparators,
} from '@mt/core'
import { CHARS_PER_TOKEN_HEURISTIC } from '../constants.js'
import { readCtx } from '../core/llm-config.js'
import { resolveTunedNum } from '../resolve-constants.js'

export {
  DEFAULT_CHUNK_SEPARATOR,
  type SplitIntoChunksOptions,
  joinChunks,
  parseChunks,
  splitIntoChunks,
  stripSeparators,
} from '@mt/core'

/** Variable with the number of separator-delimited chunks in the result text. */
export const VAR_CHUNK_COUNT = 'chunkCount'
/** Variable with the separator line used between chunks. */
export const VAR_CHUNK_SEPARATOR = 'chunkSeparator'

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
 * `MT_CHUNK_SIZE` env → `DEFAULT_CHUNK_TARGET` override chain (constants variable →
 * mt.json `settings.constants.DEFAULT_CHUNK_TARGET` → `MT_CONST_DEFAULT_CHUNK_TARGET` env)
 * → {@link DEFAULT_CHUNK_TARGET}.
 */
export function resolveChunkSize(
  env: Pick<Exchange, 'meta'> & { variables?: Variable[] },
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
  return resolveTunedNum('DEFAULT_CHUNK_TARGET', DEFAULT_CHUNK_TARGET, env, ctx)
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
    annotations: [
      tool('TL208', {
        name: 'chunk-clean',
        description: 'Strips separator and decorative lines from fixated chunks.',
        refs: ['UC058'],
      }),
      useCase('UC058'),
      category(['normalizer']),
    ],
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
    annotations: [
      tool('TL209', {
        name: 'chunk-split',
        description: 'Splits text into token-bounded chunks fixated by separators.',
        refs: ['UC056'],
        meta: { alsoCovers: ['TL106'] },
      }),
      useCase('UC056'),
      category(['splitter']),
    ],
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

// ---------------------------------------------------------------------------
// Tokenization
// ---------------------------------------------------------------------------

/** BPE encodings supported by {@link tokenizeChunk}. */
export type TokenEncoding = 'o200k_base' | 'cl100k_base' | 'p50k_base' | 'r50k_base'

/** One BPE token of a chunk. */
export interface ChunkToken {
  /** BPE token id (or a running index when the result is heuristic). */
  tokenId: number
  /** Decoded text piece. */
  text: string
}

export interface TokenizeChunkOptions {
  /** BPE encoding. Default: the `gpt-tokenizer` default (`o200k_base`). */
  encoding?: TokenEncoding
}

export interface TokenizeChunkResult {
  tokens: ChunkToken[]
  /** True when `gpt-tokenizer` was unavailable and ~4-char pieces were used. */
  heuristic: boolean
}

interface BpeCodec {
  encode(text: string): number[]
  decode(tokens: Iterable<number>): string
}

async function loadCodec(encoding?: TokenEncoding): Promise<BpeCodec | undefined> {
  try {
    if (!encoding) return (await import('gpt-tokenizer')) as BpeCodec
    switch (encoding) {
      case 'o200k_base':
        return (await import('gpt-tokenizer/encoding/o200k_base')) as BpeCodec
      case 'cl100k_base':
        return (await import('gpt-tokenizer/encoding/cl100k_base')) as BpeCodec
      case 'p50k_base':
        return (await import('gpt-tokenizer/encoding/p50k_base')) as BpeCodec
      case 'r50k_base':
        return (await import('gpt-tokenizer/encoding/r50k_base')) as BpeCodec
    }
  } catch {
    return undefined
  }
}

/** Fallback: consecutive ~4-character pieces, ids are running indexes. */
function heuristicPieces(text: string): ChunkToken[] {
  const pieces: ChunkToken[] = []
  const chars = Array.from(text)
  for (let i = 0; i < chars.length; i += CHARS_PER_TOKEN_HEURISTIC) {
    pieces.push({
      tokenId: pieces.length,
      text: chars.slice(i, i + CHARS_PER_TOKEN_HEURISTIC).join(''),
    })
  }
  return pieces
}

/**
 * Tokenize a chunk into BPE tokens (what the LLM actually sees). Each token is
 * decoded on its own with `decode([id])`; a token that holds only part of a
 * multi-byte character decodes to the replacement character. Falls back to
 * ~4-character pieces (flagged `heuristic`) when `gpt-tokenizer` is unavailable.
 */
export async function tokenizeChunkDetailed(
  text: string,
  options: TokenizeChunkOptions = {},
): Promise<TokenizeChunkResult> {
  if (text.length === 0) return { tokens: [], heuristic: false }
  const codec = await loadCodec(options.encoding)
  if (!codec) return { tokens: heuristicPieces(text), heuristic: true }
  const tokens = codec.encode(text).map((tokenId) => ({ tokenId, text: codec.decode([tokenId]) }))
  return { tokens, heuristic: false }
}

/** Tokenize a chunk into `{ tokenId, text }` pairs. See {@link tokenizeChunkDetailed}. */
export async function tokenizeChunk(
  text: string,
  options: TokenizeChunkOptions = {},
): Promise<ChunkToken[]> {
  return (await tokenizeChunkDetailed(text, options)).tokens
}
