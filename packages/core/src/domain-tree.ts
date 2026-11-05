import type { Chapter, Chunk, Line, Paragraph, Token, Word } from './domain.js'
import {
  DEFAULT_CHUNK_SEPARATOR,
  parseChunks,
  splitLineUnits,
  splitParagraphUnits,
} from './text-split.js'

/** One BPE/token piece returned by an injected tokenizer. */
export interface TokenPart {
  tokenId: number
  text: string
}

export type ChunkBodySplitter = (body: string) => string[]
export type ParagraphBodySplitter = (body: string) => string[]
export type DomainTreeTokenizer = (body: string) => TokenPart[]

/** Options for the in-memory domain tree view. Core stays dependency-free. */
export interface DomainTreeOptions {
  /** Separator line between chunks. Default `---`. */
  separator?: string
  /** Custom chapter-body -> chunk-body splitter. */
  splitChunks?: ChunkBodySplitter
  /** Custom chunk-body -> paragraph-body splitter. */
  splitParagraphs?: ParagraphBodySplitter
  /** Sync tokenizer for the alternate chunk -> tokens descent. */
  tokenize?: DomainTreeTokenizer
}

/** Chapter identity used by {@link parseChapterTree}. */
export interface ChapterTreeInput extends Pick<Chapter, 'id' | 'bookId'> {
  title?: string
  url?: string
  index?: number
}

/**
 * Read-side structural view over chapter body content, scenario-agnostic.
 * {@link ChapterNode} satisfies it; plain `Chapter`/markdown inputs adapt via
 * {@link chapterBody} / {@link chapterBodyFromMarkdown}.
 */
export interface ChapterBody {
  /** Canonical serialized markdown body (no `# title`, no frontmatter). */
  readonly text: string
  chunks(opts?: DomainTreeOptions): ChunkNode[]
  paragraphs(): ParagraphNode[]
  lines(): LineNode[]
  words(): WordNode[]
}

function normalizeNewlines(text: string): string {
  return text.replace(/\r\n?/g, '\n')
}

function normalizeBlock(text: string): string {
  return normalizeNewlines(text).trim()
}

function nonEmptyBlocks(parts: string[]): string[] {
  return parts.map((part) => normalizeNewlines(part).trim()).filter((part) => part.length > 0)
}

function defaultSplitChunks(body: string, separator: string): string[] {
  return parseChunks(normalizeNewlines(body), separator)
}

function defaultSplitParagraphs(body: string): string[] {
  return splitParagraphUnits(normalizeNewlines(body))
}

function defaultSplitLines(body: string): string[] {
  return splitLineUnits(body)
}

function lineTexts(input: string | string[]): string[] {
  const parts = Array.isArray(input) ? input : [input]
  return nonEmptyBlocks(parts.flatMap((part) => normalizeNewlines(part).split('\n')))
}

function normalizeLineText(text: string): string {
  return normalizeNewlines(text)
    .split('\n')
    .map((line) => line.trim())
    .join(' ')
}

interface WordSpan {
  word: string
  start: number
  end: number
}

function wordSpans(text: string): WordSpan[] {
  const spans: WordSpan[] = []
  for (const match of text.matchAll(/\S+/g)) {
    const start = match.index ?? 0
    spans.push({ word: match[0], start, end: start + match[0].length })
  }
  return spans
}

function applyTreeOptions(target: DomainTreeOptions, opts: DomainTreeOptions): void {
  if (opts.separator !== undefined) target.separator = opts.separator
  if (opts.splitChunks !== undefined) target.splitChunks = opts.splitChunks
  if (opts.splitParagraphs !== undefined) target.splitParagraphs = opts.splitParagraphs
  if (opts.tokenize !== undefined) target.tokenize = opts.tokenize
}

function serializeParagraphs(paragraphs: ParagraphNode[]): string {
  return paragraphs
    .map((paragraph) => paragraph.body)
    .filter((body) => body.length > 0)
    .join('\n\n')
}

function serializeChunks(chunks: ChunkNode[], separator: string): string {
  return chunks
    .map((chunk) => chunk.body)
    .filter((body) => body.length > 0)
    .join(`\n\n${separator}\n\n`)
}

/**
 * Mutable chapter view. `body` serializes the current chunk/paragraph/line tree;
 * `toChapter()` returns the plain wire-shape snapshot.
 */
export class ChapterNode implements Chapter, ChapterBody {
  readonly id: string
  readonly bookId: string
  url?: string
  index?: number
  private _title: string
  private _sourceBody: string
  private _chunks: ChunkNode[] | undefined
  private readonly _options: DomainTreeOptions

  constructor(chapter: Chapter, options: DomainTreeOptions = {}) {
    this.id = chapter.id
    this.bookId = chapter.bookId
    this.url = chapter.url
    this.index = chapter.index
    this._title = chapter.title
    this._sourceBody = normalizeBlock(chapter.body)
    this._options = { ...options }
  }

  get title(): string {
    return this._title
  }

  set title(value: string) {
    this._title = value
  }

  get body(): string {
    if (this._chunks === undefined) return this._sourceBody
    return serializeChunks(this._chunks, this._options.separator ?? DEFAULT_CHUNK_SEPARATOR)
  }

  set body(value: string) {
    this._sourceBody = normalizeBlock(value)
    this._chunks = undefined
  }

  /** {@link ChapterBody} alias of {@link body}. */
  get text(): string {
    return this.body
  }

  chunks(opts: DomainTreeOptions = {}): ChunkNode[] {
    if (this._chunks === undefined) {
      applyTreeOptions(this._options, opts)
      this._chunks = this.buildChunks(this._sourceBody)
    } else if (opts.splitChunks !== undefined || opts.separator !== undefined) {
      const source = this.body
      applyTreeOptions(this._options, opts)
      this._chunks = this.buildChunks(source)
    } else {
      applyTreeOptions(this._options, opts)
    }
    return this._chunks
  }

  paragraphs(): ParagraphNode[] {
    return this.chunks().flatMap((chunk) => chunk.paragraphs())
  }

  lines(): LineNode[] {
    return this.paragraphs().flatMap((paragraph) => paragraph.lines)
  }

  words(): WordNode[] {
    return this.lines().flatMap((line) => line.words())
  }

  toMarkdown(): string {
    return `# ${this.title}\n\n${this.body}`
  }

  toChapter(): Chapter {
    const chapter: Chapter = {
      id: this.id,
      bookId: this.bookId,
      title: this.title,
      body: this.body,
    }
    if (this.url !== undefined) chapter.url = this.url
    if (this.index !== undefined) chapter.index = this.index
    return chapter
  }

  private buildChunks(source: string): ChunkNode[] {
    const separator = this._options.separator ?? DEFAULT_CHUNK_SEPARATOR
    const splitChunks =
      this._options.splitChunks ?? ((body: string) => defaultSplitChunks(body, separator))
    return splitChunks(source).map(
      (body, index) =>
        new ChunkNode(
          { id: `${this.id}:c${index}`, chapterId: this.id, body, index },
          this._options,
        ),
    )
  }
}

/**
 * Mutable chunk view. `tokens()` is the alternate descent and requires an injected
 * synchronous tokenizer; paragraph descent stays the default.
 */
export class ChunkNode implements Omit<Chunk, 'tokens'> {
  readonly id: string
  readonly chapterId: string
  index?: number
  private _sourceBody: string
  private _paragraphs: ParagraphNode[] | undefined
  private readonly _options: DomainTreeOptions

  constructor(chunk: Chunk, options: DomainTreeOptions) {
    this.id = chunk.id
    this.chapterId = chunk.chapterId
    this.index = chunk.index
    this._sourceBody = normalizeBlock(chunk.body)
    this._options = options
  }

  get body(): string {
    if (this._paragraphs === undefined) return this._sourceBody
    return serializeParagraphs(this._paragraphs)
  }

  set body(value: string) {
    this._sourceBody = normalizeBlock(value)
    this._paragraphs = undefined
  }

  paragraphs(): ParagraphNode[] {
    if (this._paragraphs === undefined) {
      const splitParagraphs = this._options.splitParagraphs ?? defaultSplitParagraphs
      this._paragraphs = splitParagraphs(this._sourceBody).map(
        (body, index) =>
          new ParagraphNode({
            id: `${this.id}:p${index}`,
            chapterId: this.chapterId,
            chunkId: this.id,
            body,
            index,
          }),
      )
    }
    return this._paragraphs
  }

  tokens(): TokenNode[] {
    const tokenize = this._options.tokenize
    if (tokenize === undefined) {
      throw new Error(
        'ChunkNode.tokens(): no tokenizer configured; pass tokenize in chapterTree/parseChapterTree options',
      )
    }
    return tokenize(this.body).map(
      (part, index) =>
        new TokenNode({
          id: `${this.id}:t${index}`,
          chunkId: this.id,
          tokenId: part.tokenId,
          text: part.text,
          index,
        }),
    )
  }

  toChunk(): Chunk {
    const chunk: Chunk = {
      id: this.id,
      chapterId: this.chapterId,
      body: this.body,
    }
    if (this.index !== undefined) chunk.index = this.index
    return chunk
  }
}

/** Mutable paragraph view: blank-line separated block descended into lines. */
export class ParagraphNode implements Paragraph {
  readonly id: string
  readonly chapterId: string
  readonly chunkId?: string
  index?: number
  private _sourceBody: string
  private _lines: LineNode[] | undefined

  constructor(paragraph: Paragraph) {
    this.id = paragraph.id
    this.chapterId = paragraph.chapterId
    this.chunkId = paragraph.chunkId
    this.index = paragraph.index
    this._sourceBody = normalizeBlock(paragraph.body)
  }

  get body(): string {
    if (this._lines === undefined) return this._sourceBody
    return this._lines.map((line) => line.text).join('\n')
  }

  set body(value: string) {
    this._sourceBody = normalizeBlock(value)
    this._lines = undefined
  }

  get lines(): LineNode[] {
    if (this._lines === undefined) {
      this._lines = defaultSplitLines(this._sourceBody).map(
        (text, index) =>
          new LineNode({ id: `${this.id}:l${index}`, paragraphId: this.id, text, index }),
      )
    }
    return this._lines
  }

  setText(input: string | string[]): void {
    this._lines = lineTexts(input).map(
      (text, index) =>
        new LineNode({ id: `${this.id}:l${index}`, paragraphId: this.id, text, index }),
    )
  }

  insertLine(index: number, input: string | string[]): void {
    const lines = this.lines
    if (index < 0 || index > lines.length) {
      throw new RangeError(`ParagraphNode.insertLine: index ${index} out of range`)
    }
    const inserted = lineTexts(input).map(
      (text, offset) =>
        new LineNode({
          id: `${this.id}:l${index + offset}`,
          paragraphId: this.id,
          text,
        }),
    )
    lines.splice(index, 0, ...inserted)
    this.renumberLines()
  }

  removeLine(index: number): void {
    const lines = this.lines
    if (index < 0 || index >= lines.length) {
      throw new RangeError(`ParagraphNode.removeLine: index ${index} out of range`)
    }
    lines.splice(index, 1)
    this.renumberLines()
  }

  toParagraph(): Paragraph {
    const paragraph: Paragraph = {
      id: this.id,
      chapterId: this.chapterId,
      body: this.body,
    }
    if (this.chunkId !== undefined) paragraph.chunkId = this.chunkId
    if (this.index !== undefined) paragraph.index = this.index
    return paragraph
  }

  private renumberLines(): void {
    this._lines?.forEach((line, index) => {
      line.id = `${this.id}:l${index}`
      line.index = index
    })
  }
}

/** Mutable line view; words are derived on demand from the current text. */
export class LineNode implements Line {
  id: string
  readonly paragraphId: string
  index?: number
  private _text: string

  constructor(line: Line) {
    this.id = line.id
    this.paragraphId = line.paragraphId
    this.index = line.index
    this._text = normalizeLineText(line.text)
  }

  get text(): string {
    return this._text
  }

  set text(value: string) {
    this._text = normalizeLineText(value)
  }

  words(): WordNode[] {
    return wordSpans(this._text).map((_, index) => new WordNode(this, index))
  }

  wordAt(index: number): string {
    return wordSpans(this._text)[index]?.word ?? ''
  }

  replaceWord(index: number, value: string): void {
    const span = wordSpans(this._text)[index]
    if (span === undefined) {
      throw new RangeError(`LineNode.replaceWord: index ${index} out of range`)
    }
    this._text = `${this._text.slice(0, span.start)}${value}${this._text.slice(span.end)}`
  }

  toLine(): Line {
    const line: Line = {
      id: this.id,
      paragraphId: this.paragraphId,
      text: this.text,
    }
    if (this.index !== undefined) line.index = this.index
    return line
  }
}

/** Mutable word view backed by its line; `word` writes through to the line text. */
export class WordNode implements Word {
  id: string
  paragraphId: string
  lineId: string
  index?: number
  private readonly _line: LineNode
  private readonly _wordIndex: number

  constructor(line: LineNode, wordIndex: number) {
    this._line = line
    this._wordIndex = wordIndex
    this.id = `${line.id}:w${wordIndex}`
    this.paragraphId = line.paragraphId
    this.lineId = line.id
    this.index = wordIndex
  }

  get word(): string {
    return this._line.wordAt(this._wordIndex)
  }

  set word(value: string) {
    this._line.replaceWord(this._wordIndex, value)
  }

  toWord(): Word {
    const word: Word = {
      id: this.id,
      paragraphId: this.paragraphId,
      lineId: this.lineId,
      word: this.word,
    }
    if (this.index !== undefined) word.index = this.index
    return word
  }
}

/** Alternate chunk descent token; text is mutable on the node snapshot. */
export class TokenNode implements Token {
  readonly id: string
  readonly chunkId: string
  readonly tokenId: number
  text: string
  index?: number

  constructor(token: Token) {
    this.id = token.id
    this.chunkId = token.chunkId
    this.tokenId = token.tokenId
    this.text = token.text
    this.index = token.index
  }

  toToken(): Token {
    const token: Token = {
      id: this.id,
      chunkId: this.chunkId,
      tokenId: this.tokenId,
      text: this.text,
    }
    if (this.index !== undefined) token.index = this.index
    return token
  }
}

/** Wrap a plain {@link Chapter} in the mutable fluent tree view. */
export function chapterTree(chapter: Chapter, opts: DomainTreeOptions = {}): ChapterNode {
  return new ChapterNode(chapter, opts)
}

/** Adapt a plain {@link Chapter} into the read-side {@link ChapterBody} view. */
export function chapterBody(chapter: Chapter, opts: DomainTreeOptions = {}): ChapterBody {
  return new ChapterNode(chapter, opts)
}

/** Adapt markdown (`# Title` + body) into the read-side {@link ChapterBody} view. */
export function chapterBodyFromMarkdown(
  markdown: string,
  chapter: ChapterTreeInput,
  opts: DomainTreeOptions = {},
): ChapterBody {
  return parseChapterTree(markdown, chapter, opts)
}

/** Parse markdown (`# Title` + body) into a {@link ChapterNode}. */
export function parseChapterTree(
  markdown: string,
  chapter: ChapterTreeInput,
  opts: DomainTreeOptions = {},
): ChapterNode {
  const lines = normalizeNewlines(markdown).split('\n')
  let cursor = 0
  while (cursor < lines.length && (lines[cursor] ?? '').trim() === '') cursor += 1

  let title = chapter.title
  let bodyStart = cursor
  const first = lines[cursor]
  if (first !== undefined && /^\s{0,3}#\s+/.test(first)) {
    if (title === undefined) title = first.trim().replace(/^#\s+/, '').trim()
    bodyStart = cursor + 1
  }

  return chapterTree(
    {
      id: chapter.id,
      bookId: chapter.bookId,
      title: title ?? '',
      body: lines.slice(bodyStart).join('\n'),
      url: chapter.url,
      index: chapter.index,
    },
    opts,
  )
}
