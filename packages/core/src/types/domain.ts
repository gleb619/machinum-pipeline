import type {
  ChunkBodySplitter,
  ChunkNode,
  DomainTreeTokenizer,
  LineBodySplitter,
  LineNode,
  LineWordSplitter,
  ParagraphBodySplitter,
  ParagraphNode,
  WordNode,
} from '../domain-tree.js'

/**
 * Book — top-level domain entity.
 * Represents a book being processed through a pipeline.
 */
export interface Book {
  id: string
  name: string
  author?: string
  year?: number
  meta?: Record<string, unknown>
}

/**
 * Chapter — a chapter within a book.
 */
export interface Chapter {
  id: string
  bookId: string
  url?: string
  title: string
  body: string
  index?: number
}

/**
 * Chunk — a token-bounded, separator-fixated slice of a chapter's text,
 * used for translation (and other LLM work) within a token budget.
 *
 * A chunk is the coarsest rung under the document: a document is split into
 * chunks first, and each chunk is then descended into paragraphs, lines and
 * words. Chunks of one chapter are joined by a separator line (see the
 * `chunkSplit` tool).
 */
export interface Chunk {
  id: string
  chapterId: string
  body: string
  index?: number
  tokens?: number
}

/**
 * Paragraph — a paragraph within a chapter, or within one of its chunks.
 */
export interface Paragraph {
  id: string
  chapterId: string
  /** Paragraph of a chunk: the id of the `Chunk` it was derived from. */
  chunkId?: string
  body: string
  index?: number
}

/**
 * ParagraphLine — a line within a paragraph.
 */
export interface ParagraphLine {
  id: string
  paragraphId: string
  text: string
  index?: number
}

/**
 * LineWord — one word within a line (the smallest rung of the Structure Ladder).
 * `LineWord` is a core entity so splitters can return a stable shape without
 * importing a sample-local type.
 */
export interface LineWord {
  id: string
  paragraphId: string
  lineId: string
  word: string
  index?: number
}

/**
 * ChapterLine — a line addressed directly under a chapter, without the
 * paragraph rung. This is the flattening path for workflows that treat a
 * chapter as a stream of lines.
 */
export interface ChapterLine {
  id: string
  chapterId: string
  text: string
  index?: number
}

/**
 * ChapterLineWord — one word of a {@link ChapterLine}. Mirrors {@link LineWord}
 * for the chapter-direct line path, so word tools work without a paragraph id.
 */
export interface ChapterLineWord {
  id: string
  chapterId: string
  lineId: string
  word: string
  index?: number
}

/**
 * Token — one tiktoken-style BPE token of a chunk.
 *
 * The alternate descent from a `Chunk` (a sibling of `Paragraph`): chunks
 * -> tokens instead of chunks -> paragraphs. A token is what the LLM
 * actually sees, so tokens are the unit for budget and cost reasoning.
 */
export interface Token {
  id: string
  /** The `Chunk` this token was derived from. */
  chunkId: string
  /** BPE token id. */
  tokenId: number
  /** Decoded text piece of the token. */
  text: string
  index?: number
}

/**
 * Read-side view over a chapter body, scenario-agnostic: `value()` is the full
 * markdown (H1 + content), `title()` the H1 header, `content()` everything below it.
 * Plain `Chapter`/markdown inputs adapt via {@link chapterBody} /
 * {@link chapterBodyFromMarkdown}.
 */
export interface ChapterBody extends ChapterText {
  /** `# <title>` header line. */
  title(): ChapterText
  /** Markdown body below the H1, with the chunk/paragraph/line/word descent. */
  content(): ChapterContent
}

/**
 * Body content below the H1: the structural descent shared by chunks, paragraphs,
 * lines and words.
 */
export interface ChapterContent extends ChapterText {
  chunks(opts?: DomainTreeOptions): ChunkNode[]
  paragraphs(): ParagraphNode[]
  lines(): LineNode[]
  words(): WordNode[]
}

/** Typed text value: read it through {@link ChapterText.value}. */
export interface ChapterText {
  /** Canonical text (markdown body, H1 header, ...). */
  value(): string
}

/** Chapter identity used by {@link parseChapterTree}. */
export interface ChapterTreeInput extends Pick<Chapter, 'id' | 'bookId'> {
  title?: string
  url?: string
  index?: number
}

/** Options for the in-memory domain tree view. Core stays dependency-free. */
export interface DomainTreeOptions {
  /** Separator line between chunks. Default `---`. */
  separator?: string
  /** Custom chapter-body -> chunk-body splitter. */
  splitChunks?: ChunkBodySplitter
  /** Custom chunk-body -> paragraph-body splitter. */
  splitParagraphs?: ParagraphBodySplitter
  /** Custom paragraph-body -> line-text splitter. */
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
