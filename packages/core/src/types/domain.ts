import {
  DEFAULT_CHUNK_SEPARATOR,
  parseChunks,
  splitLineUnits,
  splitParagraphUnits,
} from '../text-split.js'

/**
 * Domain model — active-record style.
 *
 * Every entity carries a stable `id` (a filename for persisted entities) and its
 * own `text`. Entities know how to descend the Structure Ladder themselves, so a
 * pipeline can do `chapter.chunks()[0].paragraphs()[0].lines[0].words()` without
 * importing the tree views:
 *
 *   Chapter.text        full markdown (`# title` + content)
 *   Chapter.body()      chapter body view (`value` / `title` / `content`)
 *   Chunk.text          chunk body
 *   Chunk.paragraphs()  chunk -> paragraphs
 *   Paragraph.text      paragraph block
 *   Paragraph.lines     paragraph -> lines
 *   ParagraphLine.text  single line
 *   ParagraphLine.words() line -> words
 *   LineWord.text       single word
 */

/** Splitter: chapter text -> chunk texts. */
export type ChunkBodySplitter = (text: string) => string[]
/** Splitter: chunk text -> paragraph texts. */
export type ParagraphBodySplitter = (text: string) => string[]
/** Splitter: paragraph text -> line texts. */
export type LineBodySplitter = (text: string) => string[]
/** Splitter: line text -> word spans. */
export type LineWordSplitter = (text: string) => WordSpan[]
/** Sync tokenizer: chunk text -> BPE token pieces. */
export type DomainTreeTokenizer = (text: string) => TokenPart[]

/** Options for the in-memory domain tree view. Core stays dependency-free. */
export interface DomainTreeOptions {
  /** Separator line between chunks. Default `---`. */
  separator?: string
  /** Custom chapter-text -> chunk-text splitter. */
  splitChunks?: ChunkBodySplitter
  /** Custom chunk-text -> paragraph-text splitter. */
  splitParagraphs?: ParagraphBodySplitter
  /** Custom paragraph-text -> line-text splitter. */
  splitLines?: LineBodySplitter
  /** Custom line-text -> word-span splitter. */
  splitWords?: LineWordSplitter
  /** Sync tokenizer for the alternate chunk -> tokens descent. */
  tokenize?: DomainTreeTokenizer
}

/** One word within a line: the word text plus its half-open `[start, end)` range. */
export interface WordSpan {
  word: string
  start: number
  end: number
}

/** One BPE/token piece returned by an injected tokenizer. */
export interface TokenPart {
  tokenId: number
  text: string
}

/** Typed text value: read it through {@link ChapterText.value}. */
export interface ChapterText {
  /** Canonical text (markdown body, H1 header, ...). */
  value(): string
}

/** Body content below the H1: the structural descent shared by chunks, paragraphs, lines and words. */
export interface ChapterContent extends ChapterText {
  chunks(opts?: DomainTreeOptions): Chunk[]
  paragraphs(opts?: DomainTreeOptions): Paragraph[]
  lines(opts?: DomainTreeOptions): ParagraphLine[]
  words(opts?: DomainTreeOptions): LineWord[]
}

/**
 * Read-side view over a chapter text, scenario-agnostic: `value()` is the full
 * markdown (H1 + content), `title()` the H1 header, `content()` everything below it.
 */
export interface ChapterBody extends ChapterText {
  /** `# <title>` header line. */
  title(): ChapterText
  /** Markdown body below the H1, with the chunk/paragraph/line/word descent. */
  content(): ChapterContent
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function normalizeNewlines(text: string): string {
  return text.replace(/\r\n?/g, '\n')
}

function normalizeBlock(text: string): string {
  return normalizeNewlines(text).trim()
}

function nonEmptyBlocks(parts: string[]): string[] {
  return parts.map((part) => normalizeNewlines(part).trim()).filter((part) => part.length > 0)
}

function defaultSplitChunks(text: string, separator: string): string[] {
  return parseChunks(normalizeNewlines(text), separator)
}

function defaultSplitParagraphs(text: string): string[] {
  return splitParagraphUnits(normalizeNewlines(text))
}

function defaultSplitLines(text: string): string[] {
  return splitLineUnits(text)
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

function wordSpans(text: string): WordSpan[] {
  const spans: WordSpan[] = []
  for (const match of text.matchAll(/\S+/g)) {
    const start = match.index ?? 0
    spans.push({ word: match[0], start, end: start + match[0].length })
  }
  return spans
}

function serializeParagraphs(paragraphs: Paragraph[]): string {
  return paragraphs
    .map((paragraph) => paragraph.text)
    .filter((text) => text.length > 0)
    .join('\n\n')
}

function serializeChunks(chunks: Chunk[], separator: string): string {
  return chunks
    .map((chunk) => chunk.text)
    .filter((text) => text.length > 0)
    .join(`\n\n${separator}\n\n`)
}

/** Non-enumerable field, so class instances keep the plain wire shape. */
function defineHidden<T extends object>(target: T, key: string, value: unknown): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: false,
    writable: true,
    configurable: true,
  })
}

/** Own, enumerable `text` accessor so the payload stays in the plain wire shape. */
function defineTextAccessor(
  target: object,
  read: () => string,
  write: (value: string) => void,
): void {
  Object.defineProperty(target, 'text', {
    enumerable: true,
    configurable: true,
    get: read,
    set: write,
  })
}

function mergeOptions(target: DomainTreeOptions, opts: DomainTreeOptions): void {
  if (opts.separator !== undefined) target.separator = opts.separator
  if (opts.splitChunks !== undefined) target.splitChunks = opts.splitChunks
  if (opts.splitParagraphs !== undefined) target.splitParagraphs = opts.splitParagraphs
  if (opts.splitLines !== undefined) target.splitLines = opts.splitLines
  if (opts.splitWords !== undefined) target.splitWords = opts.splitWords
  if (opts.tokenize !== undefined) target.tokenize = opts.tokenize
}

/** First `# ` heading of a markdown text, or `undefined` when absent. */
function readHeading(text: string): { title: string; contentStart: number } | undefined {
  const lines = normalizeNewlines(text).split('\n')
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? ''
    if (/^\s{0,3}#\s+/.test(line)) {
      return { title: line.trim().replace(/^#\s+/, '').trim(), contentStart: i + 1 }
    }
    if (line.trim() !== '') return undefined
  }
  return undefined
}

// ---------------------------------------------------------------------------
// Chapter meta + Book
// ---------------------------------------------------------------------------

/** Chapter header metadata (YAML frontmatter). */
export interface ChapterMetaInit {
  bookId: string
  url?: string
  index?: number
}

/**
 * Mutable chapter metadata. Values are plain and directly assignable; the
 * helpers (`set` / `patch` / `get` / `has`) are the active-record seam for
 * pipeline code:
 *
 *   chapter.meta.url = 'https://…'
 *   chapter.meta.set('index', 3)
 */
export class ChapterMeta implements ChapterMetaInit {
  bookId: string
  url?: string
  index?: number

  constructor(init: ChapterMetaInit) {
    this.bookId = init.bookId
    if (init.url !== undefined) this.url = init.url
    if (init.index !== undefined) this.index = init.index
  }

  /** Read one metadata value. */
  get<K extends keyof ChapterMetaInit>(key: K): ChapterMetaInit[K] {
    return this[key]
  }

  /** True when the key exists and is not `undefined`. */
  has<K extends keyof ChapterMetaInit>(key: K): boolean {
    return this[key] !== undefined
  }

  /** Set one metadata value; `undefined` removes it. Returns `this` for chaining. */
  set<K extends keyof ChapterMetaInit>(key: K, value: ChapterMetaInit[K] | undefined): this {
    if (value === undefined) {
      Reflect.deleteProperty(this, key)
    } else {
      ;(this as unknown as Record<string, unknown>)[key] = value
    }
    return this
  }

  /** Merge a partial metadata block. Returns `this` for chaining. */
  patch(partial: Partial<ChapterMetaInit>): this {
    for (const [key, value] of Object.entries(partial)) {
      this.set(key as keyof ChapterMetaInit, value as never)
    }
    return this
  }

  /** Plain wire-shape snapshot. */
  toObject(): ChapterMetaInit {
    const meta: ChapterMetaInit = { bookId: this.bookId }
    if (this.url !== undefined) meta.url = this.url
    if (this.index !== undefined) meta.index = this.index
    return meta
  }
}

/** Constructor input for {@link Book}; every Java field is optional except `id`. */
export interface BookInit {
  id?: string
  uniqueId?: string
  ruName?: string
  enName?: string
  originName?: string
  link?: string
  linkText?: string
  type?: string
  genre?: string[]
  tags?: string[]
  year?: number
  chapters?: number
  author?: string
  description?: string
  imageId?: string
  imageData?: string
  originImageId?: string
  jsonlFileLink?: string
  jsonlFileData?: string
  createdAt?: string
  updatedAt?: string
}

/**
 * Book — top-level domain entity. Fields mirror the Java `machinum.book.Book`
 * record; metadata helpers (`get` / `set` / `patchMeta`) mutate values in place
 * so pipeline code can adjust them without rebuilding the object.
 */
export class Book
  implements Required<Omit<BookInit, 'description' | 'jsonlFileLink' | 'jsonlFileData'>>
{
  id: string
  uniqueId: string
  ruName: string
  enName: string
  originName: string
  link: string
  linkText: string
  type: string
  genre: string[]
  tags: string[]
  year: number
  chapters: number
  author: string
  description?: string
  imageId: string
  imageData: string
  originImageId: string
  jsonlFileLink?: string
  jsonlFileData?: string
  createdAt: string
  updatedAt: string

  constructor(init: BookInit = {}) {
    const now = new Date().toISOString()
    this.id = init.id ?? ''
    this.uniqueId = init.uniqueId ?? ''
    this.ruName = init.ruName ?? ''
    this.enName = init.enName ?? ''
    this.originName = init.originName ?? ''
    this.link = init.link ?? ''
    this.linkText = init.linkText ?? ''
    this.type = init.type ?? ''
    this.genre = [...(init.genre ?? [])]
    this.tags = [...(init.tags ?? [])]
    this.year = init.year ?? 0
    this.chapters = init.chapters ?? 0
    this.author = init.author ?? ''
    if (init.description !== undefined) this.description = init.description
    this.imageId = init.imageId ?? ''
    this.imageData = init.imageData ?? ''
    this.originImageId = init.originImageId ?? ''
    if (init.jsonlFileLink !== undefined) this.jsonlFileLink = init.jsonlFileLink
    if (init.jsonlFileData !== undefined) this.jsonlFileData = init.jsonlFileData
    this.createdAt = init.createdAt ?? now
    this.updatedAt = init.updatedAt ?? now
  }

  /** Read one field. */
  get<K extends keyof BookInit>(key: K): BookInit[K] {
    return this[key as keyof this] as BookInit[K]
  }

  /** Set one field; `undefined` removes optional fields. Returns `this` for chaining. */
  set<K extends keyof BookInit>(key: K, value: BookInit[K]): this {
    if (value === undefined) {
      Reflect.deleteProperty(this, key)
    } else if (key === 'genre' || key === 'tags') {
      ;(this as unknown as Record<string, unknown>)[key] = [...(value as string[])]
    } else {
      ;(this as unknown as Record<string, unknown>)[key] = value
    }
    return this
  }

  /** Merge a partial book; returns `this` for chaining. */
  patch(partial: Partial<BookInit>): this {
    for (const [key, value] of Object.entries(partial)) {
      this.set(key as keyof BookInit, value as never)
    }
    return this
  }

  /** Metadata fields (everything except the identity `id`). */
  getMeta(): Omit<BookInit, 'id'> {
    const { id: _id, ...meta } = this
    return meta
  }

  /** Merge metadata fields (everything except `id`). Returns `this` for chaining. */
  patchMeta(partial: Omit<BookInit, 'id'>): this {
    return this.patch(partial)
  }

  /** Plain wire-shape snapshot. */
  toObject(): BookInit {
    return { ...this }
  }
}

// ---------------------------------------------------------------------------
// Chapter
// ---------------------------------------------------------------------------

export interface ChapterInit {
  id: string
  text: string
  meta: ChapterMetaInit
}

/** {@link ChapterText} over a reader callback, so later mutations stay visible. */
class TextValue implements ChapterText {
  readonly #read: () => string

  constructor(read: () => string) {
    this.#read = read
  }

  value(): string {
    return this.#read()
  }
}

/** {@link ChapterContent} over a live {@link Chapter}. */
class ContentValue implements ChapterContent {
  readonly #chapter: Chapter

  constructor(chapter: Chapter) {
    this.#chapter = chapter
  }

  value(): string {
    return this.#chapter.content
  }

  chunks(opts: DomainTreeOptions = {}): Chunk[] {
    return this.#chapter.chunks(opts)
  }

  paragraphs(opts: DomainTreeOptions = {}): Paragraph[] {
    return this.#chapter.paragraphs(opts)
  }

  lines(opts: DomainTreeOptions = {}): ParagraphLine[] {
    return this.#chapter.lines(opts)
  }

  words(opts: DomainTreeOptions = {}): LineWord[] {
    return this.#chapter.words(opts)
  }
}

/** {@link ChapterBody}: `value()` is H1 + content, `title()` the H1, `content()` the rest. */
class BodyValue implements ChapterBody {
  readonly #chapter: Chapter
  readonly #content: ContentValue

  constructor(chapter: Chapter) {
    this.#chapter = chapter
    this.#content = new ContentValue(chapter)
  }

  value(): string {
    return this.#chapter.text
  }

  title(): ChapterText {
    return new TextValue(() => `# ${this.#chapter.title}`)
  }

  content(): ChapterContent {
    return this.#content
  }
}

/**
 * Chapter — `id` is its filename, `meta` is the YAML header, `text` is the full
 * markdown (`# title` + content). `body()` exposes the read-side
 * {@link ChapterBody} view; the split methods descend the Structure Ladder.
 */
export class Chapter {
  id: string
  meta: ChapterMeta
  declare text: string

  private _options!: DomainTreeOptions
  private _sourceText!: string
  private _chunks: Chunk[] | undefined

  constructor(init: ChapterInit, options: DomainTreeOptions = {}) {
    this.id = init.id
    this.meta = new ChapterMeta(init.meta)
    defineHidden(this, '_sourceText', normalizeBlock(init.text))
    defineHidden(this, '_options', { ...options })
    defineHidden(this, '_chunks', undefined)
    defineTextAccessor(
      this,
      () => {
        if (this._chunks === undefined) return this._sourceText
        const body = serializeChunks(
          this._chunks,
          this._options.separator ?? DEFAULT_CHUNK_SEPARATOR,
        )
        const heading = readHeading(this._sourceText)
        if (heading === undefined) return body
        return body.length > 0 ? `# ${heading.title}\n\n${body}` : `# ${heading.title}`
      },
      (value) => {
        this._sourceText = normalizeBlock(value)
        this._chunks = undefined
      },
    )
  }

  /** H1 title, parsed from {@link Chapter.text}. */
  get title(): string {
    return readHeading(this._sourceText)?.title ?? ''
  }

  /** Rewrites the H1 line (prepends one when the text has no heading). */
  set title(value: string) {
    const heading = readHeading(this.text)
    const next = `# ${value}`
    if (heading === undefined) {
      this.text = this.text.length > 0 ? `${next}\n\n${this.text}` : next
      return
    }
    const lines = normalizeNewlines(this.text).split('\n')
    lines[heading.contentStart - 1] = next
    this.text = lines.join('\n')
    this._chunks = undefined
  }

  /** Markdown below the H1 (all of the text when there is no heading). */
  get content(): string {
    if (this._chunks !== undefined) {
      return serializeChunks(this._chunks, this._options.separator ?? DEFAULT_CHUNK_SEPARATOR)
    }
    const heading = readHeading(this._sourceText)
    if (heading === undefined) return this._sourceText
    return normalizeNewlines(this._sourceText)
      .split('\n')
      .slice(heading.contentStart)
      .join('\n')
      .trim()
  }

  /** Replaces the content below the H1; the title is preserved. */
  set content(value: string) {
    const next = normalizeBlock(value)
    const heading = readHeading(this._sourceText)
    this._sourceText = heading === undefined ? next : `# ${heading.title}\n\n${next}`
    this._chunks = undefined
  }

  /** Read-side body view (`value` / `title` / `content`). */
  body(): ChapterBody {
    return new BodyValue(this)
  }

  /** Descend chapter -> chunks. */
  chunks(opts: DomainTreeOptions = {}): Chunk[] {
    mergeOptions(this._options, opts)
    if (
      this._chunks === undefined ||
      opts.splitChunks !== undefined ||
      opts.separator !== undefined
    ) {
      const separator = this._options.separator ?? DEFAULT_CHUNK_SEPARATOR
      const splitChunks =
        this._options.splitChunks ?? ((text: string) => defaultSplitChunks(text, separator))
      this._chunks = splitChunks(this.content).map(
        (text, index) =>
          new Chunk({ id: `${this.id}:c${index}`, chapterId: this.id, text, index }, this._options),
      )
    }
    return this._chunks
  }

  /** Chapter -> paragraphs (flattened in document order). */
  paragraphs(opts: DomainTreeOptions = {}): Paragraph[] {
    return this.chunks(opts).flatMap((chunk) => chunk.paragraphs(opts))
  }

  /** Chapter -> lines (flattened in document order). */
  lines(opts: DomainTreeOptions = {}): ParagraphLine[] {
    return this.paragraphs(opts).flatMap((paragraph) => paragraph.lines)
  }

  /** Chapter -> words (flattened in document order). */
  words(opts: DomainTreeOptions = {}): LineWord[] {
    return this.lines(opts).flatMap((line) => line.words())
  }

  /** Set one metadata value. Returns `this` for chaining. */
  setMeta<K extends keyof ChapterMetaInit>(key: K, value: ChapterMetaInit[K] | undefined): this {
    this.meta.set(key, value)
    return this
  }

  /** Merge a partial metadata block. Returns `this` for chaining. */
  patchMeta(partial: Partial<ChapterMetaInit>): this {
    this.meta.patch(partial)
    return this
  }

  /** Read the metadata block. */
  getMeta(): ChapterMetaInit {
    return this.meta.toObject()
  }

  /** Full markdown (`# title` + content). */
  toMarkdown(): string {
    return this.text
  }

  /** Plain wire-shape snapshot. */
  toChapter(): Chapter {
    return new Chapter(this.toInit(), this._options)
  }

  /** Constructor input for this chapter. */
  toInit(): ChapterInit {
    return { id: this.id, meta: this.meta.toObject(), text: this.text }
  }
}

// ---------------------------------------------------------------------------
// Chunk / Paragraph / Line / Word
// ---------------------------------------------------------------------------

export interface ChunkInit {
  id: string
  chapterId: string
  text: string
  index?: number
  tokenCount?: number
}

/** Chunk — token-bounded slice of a chapter's content. */
export class Chunk {
  id: string
  chapterId: string
  declare text: string
  index?: number
  tokenCount?: number

  private _options!: DomainTreeOptions
  private _sourceText!: string
  private _paragraphs: Paragraph[] | undefined

  constructor(init: ChunkInit, options: DomainTreeOptions = {}) {
    this.id = init.id
    this.chapterId = init.chapterId
    defineHidden(this, '_sourceText', normalizeBlock(init.text))
    defineHidden(this, '_options', { ...options })
    defineHidden(this, '_paragraphs', undefined)
    if (init.index !== undefined) this.index = init.index
    if (init.tokenCount !== undefined) this.tokenCount = init.tokenCount
    defineTextAccessor(
      this,
      () =>
        this._paragraphs === undefined ? this._sourceText : serializeParagraphs(this._paragraphs),
      (value) => {
        this._sourceText = normalizeBlock(value)
        this._paragraphs = undefined
      },
    )
  }

  /** Descend chunk -> paragraphs. */
  paragraphs(opts: DomainTreeOptions = {}): Paragraph[] {
    mergeOptions(this._options, opts)
    if (this._paragraphs === undefined || opts.splitParagraphs !== undefined) {
      const splitParagraphs = this._options.splitParagraphs ?? defaultSplitParagraphs
      this._paragraphs = splitParagraphs(this.text).map(
        (text, index) =>
          new Paragraph(
            {
              id: `${this.id}:p${index}`,
              chapterId: this.chapterId,
              chunkId: this.id,
              text,
              index,
            },
            this._options,
          ),
      )
    }
    return this._paragraphs
  }

  /** Alternate descent chunk -> tokens (requires an injected tokenizer). */
  tokens(): Token[] {
    const tokenize = this._options.tokenize
    if (tokenize === undefined) {
      throw new Error('Chunk.tokens(): no tokenizer configured; pass tokenize in the tree options')
    }
    return tokenize(this.text).map(
      (part, index) =>
        new Token({
          id: `${this.id}:t${index}`,
          chunkId: this.id,
          tokenId: part.tokenId,
          text: part.text,
          index,
        }),
    )
  }

  /** Plain wire-shape snapshot. */
  toChunk(): Chunk {
    const init: ChunkInit = { id: this.id, chapterId: this.chapterId, text: this.text }
    if (this.index !== undefined) init.index = this.index
    if (this.tokenCount !== undefined) init.tokenCount = this.tokenCount
    return new Chunk(init, this._options)
  }
}

export interface ParagraphInit {
  id: string
  chapterId: string
  text: string
  chunkId?: string
  index?: number
}

/** Paragraph — blank-line separated block within a chunk or a chapter. */
export class Paragraph {
  id: string
  chapterId: string
  chunkId?: string
  index?: number
  declare text: string

  private _options!: DomainTreeOptions
  private _sourceText!: string
  private _lines: ParagraphLine[] | undefined

  constructor(init: ParagraphInit, options: DomainTreeOptions = {}) {
    this.id = init.id
    this.chapterId = init.chapterId
    if (init.chunkId !== undefined) this.chunkId = init.chunkId
    if (init.index !== undefined) this.index = init.index
    defineHidden(this, '_sourceText', normalizeBlock(init.text))
    defineHidden(this, '_options', { ...options })
    defineHidden(this, '_lines', undefined)
    defineTextAccessor(
      this,
      () =>
        this._lines === undefined
          ? this._sourceText
          : this._lines.map((line) => line.text).join('\n'),
      (value) => {
        this._sourceText = normalizeBlock(value)
        this._lines = undefined
      },
    )
  }

  /** Descend paragraph -> lines. */
  get lines(): ParagraphLine[] {
    if (this._lines === undefined) {
      const splitLines = this._options.splitLines ?? defaultSplitLines
      this._lines = splitLines(this._sourceText).map(
        (text, index) =>
          new ParagraphLine(
            { id: `${this.id}:l${index}`, paragraphId: this.id, text, index },
            this._options,
          ),
      )
    }
    return this._lines
  }

  /** Replace every line with the given text(s). */
  setText(input: string | string[]): void {
    this._lines = lineTexts(input).map(
      (text, index) =>
        new ParagraphLine(
          { id: `${this.id}:l${index}`, paragraphId: this.id, text, index },
          this._options,
        ),
    )
  }

  /** Insert line(s) at `index`. */
  insertLine(index: number, input: string | string[]): void {
    const lines = this.lines
    if (index < 0 || index > lines.length) {
      throw new RangeError(`Paragraph.insertLine: index ${index} out of range`)
    }
    const inserted = lineTexts(input).map(
      (text, offset) =>
        new ParagraphLine(
          {
            id: `${this.id}:l${index + offset}`,
            paragraphId: this.id,
            text,
            index: index + offset,
          },
          this._options,
        ),
    )
    lines.splice(index, 0, ...inserted)
    this._renumberLines()
  }

  /** Remove the line at `index`. */
  removeLine(index: number): void {
    const lines = this.lines
    if (index < 0 || index >= lines.length) {
      throw new RangeError(`Paragraph.removeLine: index ${index} out of range`)
    }
    lines.splice(index, 1)
    this._renumberLines()
  }

  /** Plain wire-shape snapshot. */
  toParagraph(): Paragraph {
    const init: ParagraphInit = { id: this.id, chapterId: this.chapterId, text: this.text }
    if (this.chunkId !== undefined) init.chunkId = this.chunkId
    if (this.index !== undefined) init.index = this.index
    return new Paragraph(init, this._options)
  }

  _renumberLines(): void {
    this._lines?.forEach((line, index) => {
      line.id = `${this.id}:l${index}`
      line.index = index
    })
  }
}

export interface ParagraphLineInit {
  id: string
  paragraphId: string
  text: string
  index?: number
}

/** ParagraphLine — a single line within a paragraph. */
export class ParagraphLine {
  id: string
  paragraphId: string
  index?: number
  declare text: string

  private _options!: DomainTreeOptions
  private _text!: string

  constructor(init: ParagraphLineInit, options: DomainTreeOptions = {}) {
    this.id = init.id
    this.paragraphId = init.paragraphId
    if (init.index !== undefined) this.index = init.index
    defineHidden(this, '_text', normalizeLineText(init.text))
    defineHidden(this, '_options', { ...options })
    defineTextAccessor(
      this,
      () => this._text,
      (value) => {
        this._text = normalizeLineText(value)
      },
    )
  }

  /** Descend line -> words. */
  words(): LineWord[] {
    return this._spans().map(
      (span, index) =>
        new LineWord(
          {
            id: `${this.id}:w${index}`,
            paragraphId: this.paragraphId,
            lineId: this.id,
            text: span.word,
            index,
          },
          this,
          index,
        ),
    )
  }

  /** Word text at `index` (`''` when out of range). */
  wordAt(index: number): string {
    return this._spans()[index]?.word ?? ''
  }

  /** Replace the word at `index`, keeping surrounding spacing. */
  replaceWord(index: number, value: string): void {
    const span = this._spans()[index]
    if (span === undefined) {
      throw new RangeError(`ParagraphLine.replaceWord: index ${index} out of range`)
    }
    this._text = `${this._text.slice(0, span.start)}${value}${this._text.slice(span.end)}`
  }

  /** Plain wire-shape snapshot. */
  toLine(): ParagraphLine {
    const init: ParagraphLineInit = {
      id: this.id,
      paragraphId: this.paragraphId,
      text: this.text,
    }
    if (this.index !== undefined) init.index = this.index
    return new ParagraphLine(init, this._options)
  }

  _spans(): WordSpan[] {
    const splitWords = this._options.splitWords ?? wordSpans
    return splitWords(this._text)
  }
}

/** LineWord — one word within a line (the smallest rung of the Structure Ladder). */
export class LineWord {
  id: string
  paragraphId: string
  lineId: string
  index?: number
  declare text: string

  private _text!: string
  private _line: ParagraphLine | undefined
  private _wordIndex!: number

  constructor(
    init: { id: string; paragraphId: string; lineId: string; text: string; index?: number },
    line: ParagraphLine | undefined = undefined,
    wordIndex = 0,
  ) {
    this.id = init.id
    this.paragraphId = init.paragraphId
    this.lineId = init.lineId
    defineHidden(this, '_text', init.text)
    if (init.index !== undefined) this.index = init.index
    defineHidden(this, '_line', line)
    defineHidden(this, '_wordIndex', wordIndex)
    defineTextAccessor(
      this,
      () => (this._line === undefined ? this._text : this._line.wordAt(this._wordIndex)),
      (value) => {
        if (this._line === undefined) {
          this._text = value
        } else {
          this._line.replaceWord(this._wordIndex, value)
        }
      },
    )
  }

  /** Plain wire-shape snapshot. */
  toWord(): LineWord {
    const init = {
      id: this.id,
      paragraphId: this.paragraphId,
      lineId: this.lineId,
      text: this.text,
    }
    const word = new LineWord(init)
    if (this.index !== undefined) word.index = this.index
    return word
  }
}

export interface ChapterLineInit {
  id: string
  chapterId: string
  text: string
  index?: number
}

/** ChapterLine — a line addressed directly under a chapter, without the paragraph rung. */
export class ChapterLine {
  id: string
  chapterId: string
  text: string
  index?: number

  constructor(init: ChapterLineInit) {
    this.id = init.id
    this.chapterId = init.chapterId
    this.text = normalizeLineText(init.text)
    if (init.index !== undefined) this.index = init.index
  }

  /** Descend chapter line -> words. */
  words(): ChapterLineWord[] {
    return wordSpans(this.text).map(
      (span, index) =>
        new ChapterLineWord({
          id: `${this.id}:w${index}`,
          chapterId: this.chapterId,
          lineId: this.id,
          text: span.word,
          index,
        }),
    )
  }
}

export interface ChapterLineWordInit {
  id: string
  chapterId: string
  lineId: string
  text: string
  index?: number
}

/** ChapterLineWord — one word of a {@link ChapterLine}. */
export class ChapterLineWord {
  id: string
  chapterId: string
  lineId: string
  text: string
  index?: number

  constructor(init: ChapterLineWordInit) {
    this.id = init.id
    this.chapterId = init.chapterId
    this.lineId = init.lineId
    this.text = init.text
    if (init.index !== undefined) this.index = init.index
  }
}

export interface TokenInit {
  id: string
  chunkId: string
  tokenId: number
  text: string
  index?: number
}

/** Token — one tiktoken-style BPE token of a chunk (alternate descent from `Chunk`). */
export class Token {
  id: string
  chunkId: string
  tokenId: number
  text: string
  index?: number

  constructor(init: TokenInit) {
    this.id = init.id
    this.chunkId = init.chunkId
    this.tokenId = init.tokenId
    this.text = init.text
    if (init.index !== undefined) this.index = init.index
  }

  /** Plain wire-shape snapshot. */
  toToken(): Token {
    const init: TokenInit = {
      id: this.id,
      chunkId: this.chunkId,
      tokenId: this.tokenId,
      text: this.text,
    }
    if (this.index !== undefined) init.index = this.index
    return new Token(init)
  }
}

/** Chapter identity used by `parseChapterTree` (the markdown supplies `text`). */
export type ChapterTreeInput = Omit<ChapterInit, 'text'>
