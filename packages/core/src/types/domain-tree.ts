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
import type { Chapter } from './domain.js'
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
