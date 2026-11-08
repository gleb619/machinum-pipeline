import type { TokenCountFn } from '../text-split.js'
export interface BalancedLineStrategyOptions {
  maxTokens?: number
  overlapChars?: number
  count?: TokenCountFn
}

export interface BalancedStrategyOptions {
  targetTokens?: number
  overlapChars?: number
  count?: TokenCountFn
}

export interface SentenceStrategyOptions {
  maxChars?: number
}

export interface WhitespaceStrategyOptions {
  maxTokens?: number
  count?: TokenCountFn
}

export interface LineStrategyOptions {
  maxTokens?: number
  count?: TokenCountFn
}

export interface ParagraphStrategyOptions {
  targetTokens?: number
  count?: TokenCountFn
}

export interface SplitIntoChunksOptions {
  /** Max tokens per chunk. Default {@link DEFAULT_CHUNK_TARGET}. */
  targetTokens?: number
  /** Token counter. Default {@link heuristicTokenCount}. */
  count?: TokenCountFn
}

export interface TokenSplitStrategy {
  readonly name: string
  split(text: string): string[] | Promise<string[]>
}
