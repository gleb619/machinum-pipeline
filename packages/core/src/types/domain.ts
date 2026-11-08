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
