import type {
  BalancedLineStrategyOptions,
  BalancedStrategyOptions,
  LineStrategyOptions,
  ParagraphStrategyOptions,
  SentenceStrategyOptions,
  SplitIntoChunksOptions,
  TokenSplitStrategy,
  WhitespaceStrategyOptions,
} from './types/text-split.js'
export type {
  TokenSplitStrategy,
  SplitIntoChunksOptions,
  ParagraphStrategyOptions,
  LineStrategyOptions,
  WhitespaceStrategyOptions,
  SentenceStrategyOptions,
  BalancedStrategyOptions,
  BalancedLineStrategyOptions,
} from './types/text-split.js'
/**
 * Pure text-splitting primitives: unit splitting, balanced partitioning and
 * separator-fixated chunking. Dependency-free so every package can reuse it.
 */

export const CHARS_PER_TOKEN_HEURISTIC = 4
export const DEFAULT_CHUNK_TARGET = 6_000
export const DEFAULT_LINE_MAX_TOKENS = 2_000
export const DEFAULT_SENTENCE_MAX_CHARS = 4_000
export const DEFAULT_OVERLAP_CHARS = 0
export const BALANCE_ALLOWED_DEVIATION = 0.05
export const DEFAULT_CHUNK_SEPARATOR = '---'
export const SENTENCE_END_RE = /[.!?](?:\s|$)/g
export const DECORATIVE_LINE_RE = /^[\s*~=_\-#+•·■-◿★☆※♦—–.]{3,}$/

/**
 * Heuristic fallback: ~4 characters per token.
 */
export function heuristicTokenCount(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN_HEURISTIC)
}

export type TokenCountFn = (text: string) => number

/** Raw line split on CR/LF. Empty lines are preserved. */
export function splitLines(text: string): string[] {
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

/**
 * Paragraph-level units: split on blank-line runs, trim each unit and drop blanks.
 */
export function splitParagraphUnits(text: string): string[] {
  return text
    .split(/\n(?:[ \t]*\n)+/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
}

/**
 * Line-level units: split on CR/LF, trim each unit and drop blanks.
 */
export function splitLineUnits(text: string): string[] {
  return splitLines(text)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
}

/**
 * Sentence-level units: split after `.` / `!` / `?`, trim each unit and drop blanks.
 * A sentence is never cut: the terminator stays with its text.
 */
export function splitSentenceUnits(text: string): string[] {
  if (!text.trim()) return []
  const sentences: string[] = []
  let cursor = 0
  for (const match of text.matchAll(SENTENCE_END_RE)) {
    const end = (match.index ?? 0) + match[0].length
    sentences.push(text.slice(cursor, end))
    cursor = end
  }
  if (cursor < text.length) sentences.push(text.slice(cursor))
  return sentences.map((sentence) => sentence.trim()).filter((sentence) => sentence.length > 0)
}

interface ReadableUnit {
  text: string
  paragraph: number
}

function joinReadableUnits(units: readonly ReadableUnit[], forcedSeparator?: string): string {
  let output = ''
  let previousParagraph: number | undefined
  for (const unit of units) {
    if (output.length === 0) {
      output = unit.text
    } else {
      const separator = forcedSeparator ?? (unit.paragraph === previousParagraph ? ' ' : '\n\n')
      output += `${separator}${unit.text}`
    }
    previousParagraph = unit.paragraph
  }
  return output.trim()
}

function partitionReadableUnits(
  units: readonly ReadableUnit[],
  count: number,
  forcedSeparator?: string,
): string[] {
  if (units.length === 0) return []
  const groupCount = Math.min(count, units.length)
  if (groupCount <= 1) return [joinReadableUnits(units, forcedSeparator)]

  const groups: ReadableUnit[][] = []
  let index = 0
  let remainingWeight = units.reduce((sum, unit) => sum + unit.text.length + 1, 0)

  for (let groupIndex = 0; groupIndex < groupCount; groupIndex++) {
    const groupsLeft = groupCount - groupIndex
    const maxEnd = units.length - (groupsLeft - 1)
    const target = remainingWeight / groupsLeft
    const first = units[index]
    if (first === undefined) break
    let end = index + 1
    let weight = first.text.length + 1

    while (end < maxEnd) {
      const next = units[end]
      if (next === undefined || weight >= target) break
      weight += next.text.length + 1
      end += 1
    }

    groups.push(units.slice(index, end))
    remainingWeight -= weight
    index = end
  }

  return groups.map((group) => joinReadableUnits(group, forcedSeparator))
}

/**
 * Split text into `parts` readable pieces without cutting a sentence.
 *
 * Two or more paragraphs are kept whole and grouped (never split mid-paragraph); a single
 * paragraph falls back to whole sentences. A sentence is never cut, so the result may contain
 * fewer than `parts` pieces when the text is too short.
 */
export function splitReadableParts(text: string, parts: number): string[] {
  const count = Number.isFinite(parts) && parts > 1 ? Math.floor(parts) : 0
  if (count < 2 || !text.trim()) return [text]

  const paragraphs = text
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph.length > 0)
  if (paragraphs.length === 0) return [text]

  // Multiple paragraphs: never break paragraph logic to hit an exact part count.
  // The result may contain fewer than `count` pieces when the chapter is short.
  if (paragraphs.length >= 2) {
    return partitionReadableUnits(
      paragraphs.map((paragraph, index) => ({ text: paragraph, paragraph: index })),
      Math.min(count, paragraphs.length),
      '\n\n',
    )
  }

  // A single paragraph: fall back to whole-sentence boundaries so the text stays readable.
  const sentences: ReadableUnit[] = []
  paragraphs.forEach((paragraph, paragraphIndex) => {
    for (const sentence of splitSentenceUnits(paragraph)) {
      sentences.push({ text: sentence, paragraph: paragraphIndex })
    }
  })
  if (sentences.length < 2) return [text]
  return partitionReadableUnits(sentences, count)
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
  const allowedDeviation = targetChunkSize * BALANCE_ALLOWED_DEVIATION

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
 * Char-level rebalancing across chunks. Order-preserving: takes characters
 * from the tail of an overfull chunk and prepends them (in order) to the
 * following underfull chunk, so `result.join('') === input.join('')`.
 */
export function rebalance(input: string[]): string[] {
  if (input.length < 2) return input

  const total = input.reduce((sum, s) => sum + s.length, 0)
  const target = Math.round(total / input.length)
  const builders = input.map((s) => ({ text: s }))

  let modified: boolean
  do {
    modified = false
    for (let i = 0; i < builders.length - 1; i++) {
      const current = builders[i]
      const next = builders[i + 1]
      if (current === undefined || next === undefined) continue
      if (current.text.length <= target || next.text.length >= target) continue
      next.text = current.text[current.text.length - 1] + next.text
      current.text = current.text.slice(0, -1)
      modified = true
    }
  } while (modified)

  return builders.map((b) => b.text)
}

/**
 * Line-level rebalancing across chunks: shifts whole lines between adjacent
 * chunks toward the mean chunk size. Two O(n) passes (forward, then backward).
 * Order-preserving: `result.join('\n') === input.join('\n')` minus any
 * chunks that became empty.
 */
export function rebalanceLines(chunks: string[]): string[] {
  if (chunks.length < 2) return chunks

  const target = Math.round(chunks.reduce((sum, c) => sum + c.length, 0) / chunks.length)
  const lines = chunks.map((chunk) => chunk.split('\n'))
  const size = (index: number): number => {
    const chunkLines = lines[index]
    return chunkLines === undefined ? 0 : chunkLines.join('\n').length
  }

  for (let i = 0; i < lines.length - 1; i++) {
    const current = lines[i]
    const next = lines[i + 1]
    if (current === undefined || next === undefined) continue
    while (size(i) > target && current.length > 1) {
      const lastLine = current.pop()
      if (lastLine === undefined) break
      next.unshift(lastLine)
    }
  }

  for (let i = lines.length - 1; i > 0; i--) {
    const current = lines[i]
    const previous = lines[i - 1]
    if (current === undefined || previous === undefined) continue
    while (size(i) < target && previous.length > 1) {
      const lastLine = previous.pop()
      if (lastLine === undefined) break
      current.unshift(lastLine)
    }
  }

  return lines.map((chunkLines) => chunkLines.join('\n')).filter((chunk) => chunk.length > 0)
}

// ---------------------------------------------------------------------------
// Separator-fixated chunking
// ---------------------------------------------------------------------------

/** True when the line is exactly the separator (surrounding whitespace ignored). */
export function isSeparatorLine(line: string, separator: string): boolean {
  return line.trim() === separator
}

/** True when the text contains at least one separator line. */
export function hasSeparators(text: string, separator: string): boolean {
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
    .filter((line) => !isSeparatorLine(line, separator) && !DECORATIVE_LINE_RE.test(line))

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

/**
 * Strip separators, then split text into chunks of at most `targetTokens` each.
 * Paragraph boundaries are preferred, line boundaries next, and a single over-long line
 * is split at word boundaries. Text is never lost, reordered, or cut mid-word; an empty
 * result means the cleaned input was empty.
 */
export function splitIntoChunks(text: string, options: SplitIntoChunksOptions = {}): string[] {
  const { targetTokens = DEFAULT_CHUNK_TARGET, count = heuristicTokenCount } = options
  const cleaned = stripSeparators(text)
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

// ---------------------------------------------------------------------------
// Strategies
// ---------------------------------------------------------------------------

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

export function lineStrategy(options?: LineStrategyOptions): TokenSplitStrategy {
  const { maxTokens = DEFAULT_LINE_MAX_TOKENS, count = heuristicTokenCount } = options ?? {}

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

export function whitespaceStrategy(options?: WhitespaceStrategyOptions): TokenSplitStrategy {
  const { maxTokens = DEFAULT_LINE_MAX_TOKENS, count = heuristicTokenCount } = options ?? {}

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

export function sentenceStrategy(options?: SentenceStrategyOptions): TokenSplitStrategy {
  const { maxChars = DEFAULT_SENTENCE_MAX_CHARS } = options ?? {}

  return {
    name: 'sentence',
    split(text: string): string[] {
      if (!text.trim()) return [text]

      const chunks: string[] = []
      let current = ''
      for (const sentence of splitSentenceUnits(text)) {
        const separator = current ? ' ' : ''
        if (current.length + separator.length + sentence.length > maxChars) {
          if (current) chunks.push(current)
          current = sentence
        } else {
          current = current ? `${current}${separator}${sentence}` : sentence
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

export function balancedStrategy(options?: BalancedStrategyOptions): TokenSplitStrategy {
  const {
    targetTokens = DEFAULT_CHUNK_TARGET,
    overlapChars = DEFAULT_OVERLAP_CHARS,
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

export function balancedLineStrategy(options?: BalancedLineStrategyOptions): TokenSplitStrategy {
  const {
    maxTokens = DEFAULT_LINE_MAX_TOKENS,
    overlapChars = DEFAULT_OVERLAP_CHARS,
    count = heuristicTokenCount,
  } = options ?? {}

  return {
    name: 'balanced-line',
    split(text: string): string[] {
      const lines = splitLines(text).filter((line) => line.trim().length > 0)
      const raw = chunkUnits(lines, count, maxTokens, '\n')
      let chunks = rebalanceLines(raw)
      if (overlapChars > 0) {
        chunks = overlap(chunks, overlapChars)
      }
      return chunks
    },
  }
}
