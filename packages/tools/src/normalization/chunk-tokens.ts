import { defineTool, setVariables, withMeta } from '@mt/core'
import type { Exchange, ToolContext } from '@mt/core'

/** Variable with the number of BPE tokens in the tokenized chunk. */
export const VAR_TOKEN_COUNT = 'tokenCount'
/** Variable that is true when the tokens are heuristic pieces, not real BPE tokens. */
export const VAR_TOKEN_HEURISTIC = 'tokenHeuristic'

/** BPE encodings supported by {@link tokenizeChunk}. */
export type TokenEncoding = 'o200k_base' | 'cl100k_base' | 'p50k_base' | 'r50k_base'

/** Average characters per token used by the fallback. */
const HEURISTIC_CHARS_PER_TOKEN = 4

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
  for (let i = 0; i < chars.length; i += HEURISTIC_CHARS_PER_TOKEN) {
    pieces.push({
      tokenId: pieces.length,
      text: chars.slice(i, i + HEURISTIC_CHARS_PER_TOKEN).join(''),
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

/** Create a chunk-tokenize tool with a fixed encoding. */
export function createChunkTokenize(options: TokenizeChunkOptions = {}) {
  return defineTool<string, ChunkToken[]>({
    name: 'chunk-tokenize',
    version: '1.0.0',
    mdDescription:
      'Tokenize a chunk (string) into tiktoken-style BPE tokens `{ tokenId, text }` via gpt-tokenizer; the alternate descent chunks -> tokens. Sets `tokenCount` (meta + variable) and the `tokenHeuristic` variable (true when the ~4 chars/token fallback was used).',
    async invoke(env: Exchange<string>, _ctx: ToolContext): Promise<Exchange<ChunkToken[]>> {
      const { tokens, heuristic } = await tokenizeChunkDetailed(env.item, options)
      const next = setVariables({ ...env, item: tokens } as Exchange<ChunkToken[]>, {
        [VAR_TOKEN_COUNT]: tokens.length,
        [VAR_TOKEN_HEURISTIC]: heuristic,
      })
      return withMeta(next, { tokenCount: tokens.length })
    },
  })
}

/** Default chunk-tokenize tool. */
export const chunkTokenize = createChunkTokenize()
