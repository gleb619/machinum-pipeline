import { defineTool, setVariables, withItem } from '@mt/core'
import type { Exchange, Tool, ToolContext } from '@mt/core'

export const DEFAULT_MAX_TOKENS = 12000
export const DEFAULT_CHUNK_TARGET = 6000

/**
 * Heuristic fallback: ~4 characters per token.
 */
export function heuristicTokenCount(text: string): number {
  return Math.ceil(text.length / 4)
}

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

export type TokenCountFn = (text: string) => number

export interface TokenSplitStrategy {
  readonly name: string
  split(text: string): string[] | Promise<string[]>
}

export interface TokenSplitterOptions {
  strategy: TokenSplitStrategy
  maxTokens?: number
}

export interface TokenSplitter extends Tool<string, string[]> {
  with(overrides: Partial<TokenSplitterOptions>): TokenSplitter
}

function splitLines(text: string): string[] {
  const lines: string[] = []
  let start = 0
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (ch === '\r' || ch === '\n') {
      lines.push(text.slice(start, i))
      start = i + 1
      if (ch === '\r' && text[i + 1] === '\n') i++
    }
  }
  lines.push(text.slice(start))
  return lines
}

function chunkUnits(
  units: string[],
  weigh: (unit: string) => number,
  budget: number,
  join: string,
): string[] {
  const chunks: string[] = []
  let current = ''
  let currentWeight = 0

  for (const unit of units) {
    const unitWeight = weigh(unit)
    if (currentWeight > 0 && currentWeight + unitWeight > budget) {
      chunks.push(current.trimEnd())
      current = unit
      currentWeight = unitWeight
    } else {
      current = current ? `${current}${join}${unit}` : unit
      currentWeight += unitWeight
    }
  }

  if (current.trim()) {
    chunks.push(current.trimEnd())
  }

  return chunks.length > 0 ? chunks : ['']
}

interface TextChunk {
  lines: string[]
  totalLength: number
}

/**
 * Port of machinum.extract.util.TextBalancer.
 * Distributes lines into a fixed number of chunks so each chunk's total
 * length (including newline delimiters) is close to the target size.
 */
export function balanceText(text: string, numChunks: number): string[] {
  if (numChunks <= 1) return [text]

  const lines = splitLines(text)
  const totalLength = lines.reduce((sum, line) => sum + line.length + 1, 0)
  const targetChunkSize = Math.max(1, Math.floor(totalLength / numChunks))
  const allowedDeviation = targetChunkSize * 0.05

  const chunks: TextChunk[] = Array.from({ length: numChunks }, () => ({
    lines: [],
    totalLength: 0,
  }))

  let currentIndex = 0
  for (const line of lines) {
    const chunk = chunks[currentIndex]
    if (chunk === undefined) {
      throw new Error('balanceText: currentIndex out of bounds')
    }
    chunk.lines.push(line)
    chunk.totalLength += line.length + 1
    if (chunk.totalLength > targetChunkSize && currentIndex < numChunks - 1) {
      currentIndex++
    }
  }

  for (let i = 0; i < chunks.length - 1; i++) {
    const currentChunk = chunks[i]
    const nextChunk = chunks[i + 1]
    if (currentChunk === undefined || nextChunk === undefined) {
      throw new Error('balanceText: chunk index out of bounds during rebalance')
    }
    while (
      currentChunk.totalLength > targetChunkSize + allowedDeviation &&
      nextChunk.lines.length > 0
    ) {
      const lastLine = currentChunk.lines.pop()
      if (lastLine === undefined) break
      currentChunk.totalLength -= lastLine.length + 1
      nextChunk.lines.unshift(lastLine)
      nextChunk.totalLength += lastLine.length + 1
    }
  }

  const balanced = chunks.map((chunk) => chunk.lines.join('\n')).filter((chunk) => chunk.length > 0)
  return balanced.length > 0 ? balanced : ['']
}

/**
 * Adds an overlap of the first `overlapSize` characters from each chunk to
 * the previous chunk (matches machinum.processor.core.SplitStrategy.Balanced).
 */
export function overlap(input: string[], overlapSize: number): string[] {
  if (input.length < 2 || overlapSize <= 0) return input

  const result = [...input]
  for (let i = 1; i < result.length; i++) {
    const previous = result[i - 1]
    const current = result[i]
    if (previous === undefined || current === undefined) {
      throw new Error('overlap: chunk index out of bounds')
    }
    const copyLength = Math.min(overlapSize, current.length)
    result[i - 1] = previous + current.slice(0, copyLength)
  }
  return result
}

/**
 * Char-level rebalancing across chunks (matches Java Balanced.rebalance).
 */
export function rebalance(input: string[]): string[] {
  if (input.length < 2) return input

  const total = input.reduce((sum, s) => sum + s.length, 0)
  const target = Math.round(total / input.length)
  const builders = input.map((s) => ({ text: s }))

  let modified: boolean
  do {
    modified = false
    for (let i = 0; i < builders.length; i++) {
      const current = builders[i]
      if (current === undefined) continue
      if (current.text.length <= target) continue
      for (let j = 0; j < builders.length; j++) {
        if (i === j) continue
        const other = builders[j]
        if (other === undefined) continue
        if (other.text.length < target) {
          other.text += current.text[current.text.length - 1]
          current.text = current.text.slice(0, -1)
          modified = true
          break
        }
      }
    }
  } while (modified)

  return builders.map((b) => b.text)
}

export interface ParagraphStrategyOptions {
  targetTokens?: number
  count?: TokenCountFn
}

export function paragraphStrategy(options?: ParagraphStrategyOptions): TokenSplitStrategy {
  const { targetTokens = DEFAULT_CHUNK_TARGET, count = heuristicTokenCount } = options ?? {}

  return {
    name: 'paragraph',
    split(text: string): string[] {
      const paragraphs = text.split(/\n\n+/)
      const chunks: string[] = []
      let current = ''
      let currentTokens = 0

      for (const paragraph of paragraphs) {
        if (!paragraph.trim()) continue
        const paragraphTokens = count(paragraph)

        if (currentTokens > 0 && currentTokens + paragraphTokens > targetTokens) {
          chunks.push(current.trimEnd())
          current = paragraph
          currentTokens = paragraphTokens
        } else {
          current = current ? `${current}\n\n${paragraph}` : paragraph
          currentTokens += paragraphTokens
        }
      }

      if (current.trim()) {
        chunks.push(current.trimEnd())
      }

      return chunks.length > 0 ? chunks : [text]
    },
  }
}

export interface LineStrategyOptions {
  maxTokens?: number
  count?: TokenCountFn
}

export function lineStrategy(options?: LineStrategyOptions): TokenSplitStrategy {
  const { maxTokens = 2000, count = heuristicTokenCount } = options ?? {}

  return {
    name: 'line',
    split(text: string): string[] {
      const lines = splitLines(text)
      return chunkUnits(
        lines.filter((line) => line.trim().length > 0),
        count,
        maxTokens,
        '\n',
      )
    },
  }
}

export interface WhitespaceStrategyOptions {
  maxTokens?: number
  count?: TokenCountFn
}

export function whitespaceStrategy(options?: WhitespaceStrategyOptions): TokenSplitStrategy {
  const { maxTokens = 2000, count = heuristicTokenCount } = options ?? {}

  return {
    name: 'whitespace',
    split(text: string): string[] {
      const words = text
        .trim()
        .split(/\s+/)
        .filter((word) => word.length > 0)
      return chunkUnits(words, count, maxTokens, ' ')
    },
  }
}

const SENTENCE_END = /[.!?](?:\s|$)/g

export interface SentenceStrategyOptions {
  maxChars?: number
}

export function sentenceStrategy(options?: SentenceStrategyOptions): TokenSplitStrategy {
  const { maxChars = 4000 } = options ?? {}

  return {
    name: 'sentence',
    split(text: string): string[] {
      if (!text.trim()) return [text]

      const sentences: string[] = []
      let cursor = 0
      for (const match of text.matchAll(SENTENCE_END)) {
        const end = (match.index ?? 0) + match[0].length
        sentences.push(text.slice(cursor, end))
        cursor = end
      }
      if (cursor < text.length) {
        sentences.push(text.slice(cursor))
      }

      const chunks: string[] = []
      let current = ''
      for (const sentence of sentences) {
        const trimmed = sentence.trim()
        if (!trimmed) continue
        const separator = current ? ' ' : ''
        if (current.length + separator.length + trimmed.length > maxChars) {
          if (current) chunks.push(current)
          current = trimmed
        } else {
          current = current ? `${current}${separator}${trimmed}` : trimmed
        }
      }
      if (current) chunks.push(current)

      return chunks.length > 0 ? chunks : [text]
    },
  }
}

export function singleStrategy(): TokenSplitStrategy {
  return {
    name: 'single',
    split: (text: string) => [text],
  }
}

export interface BalancedStrategyOptions {
  targetTokens?: number
  overlapChars?: number
  count?: TokenCountFn
}

export function balancedStrategy(options?: BalancedStrategyOptions): TokenSplitStrategy {
  const {
    targetTokens = DEFAULT_CHUNK_TARGET,
    overlapChars = 0,
    count = heuristicTokenCount,
  } = options ?? {}

  return {
    name: 'balanced',
    split(text: string): string[] {
      const tokens = count(text)
      if (tokens <= targetTokens) return [text]

      const lineCount = splitLines(text).length
      const desiredChunks = Math.max(2, Math.ceil(tokens / targetTokens))
      const numChunks = Math.min(desiredChunks, lineCount)
      if (numChunks <= 1) return [text]

      let chunks = balanceText(text, numChunks)
      if (overlapChars > 0) {
        chunks = overlap(chunks, overlapChars)
      }
      return chunks
    },
  }
}

export interface BalancedLineStrategyOptions {
  maxTokens?: number
  overlapChars?: number
  count?: TokenCountFn
}

export function balancedLineStrategy(options?: BalancedLineStrategyOptions): TokenSplitStrategy {
  const { maxTokens = 2000, overlapChars = 0, count = heuristicTokenCount } = options ?? {}

  return {
    name: 'balanced-line',
    split(text: string): string[] {
      const lines = splitLines(text).filter((line) => line.trim().length > 0)
      const raw = chunkUnits(lines, count, maxTokens, '\n')
      let chunks = rebalance(raw)
      if (overlapChars > 0) {
        chunks = overlap(chunks, overlapChars)
      }
      return chunks
    },
  }
}

export function createTokenSplitter(options: Partial<TokenSplitterOptions> = {}): TokenSplitter {
  const maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS
  const strategy = options.strategy ?? paragraphStrategy()

  const base = defineTool<string, string[]>({
    name: 'token-splitter',
    version: '1.0.0',
    mdDescription:
      'Splits text into chunks using a pluggable TokenSplitStrategy. Default strategy splits at paragraph boundaries respecting a token limit.',
    async invoke(env: Exchange<string>, _ctx: ToolContext): Promise<Exchange<string[]>> {
      const inputs = env.items ?? [env.item]
      const allChunks: string[] = []

      for (const input of inputs) {
        const tokenCount = await countTokens(input)
        if (tokenCount <= maxTokens) {
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
