import {
  Chapter,
  type ChapterBody,
  type ChapterInit,
  type ChapterTreeInput,
  Chunk,
  type ChunkInit,
  type DomainTreeOptions,
  LineWord,
  Paragraph,
  type ParagraphInit,
  ParagraphLine,
  type ParagraphLineInit,
  Token,
} from './types/domain.js'

/**
 * Active-record domain entities already implement the whole Structure Ladder
 * (`Chapter.body()` / `chunks()`, `Chunk.paragraphs()`, `Paragraph.lines`,
 * `ParagraphLine.words()`). The tree module keeps the historical node names as
 * thin subclasses plus the markdown adapters, so existing pipeline code and
 * tests keep one entry point.
 */

export type {
  ChunkBodySplitter,
  DomainTreeTokenizer,
  LineBodySplitter,
  LineWordSplitter,
  ParagraphBodySplitter,
} from './types/domain.js'

/** Mutable chapter view; the plain wire snapshot comes from {@link Chapter.toChapter}. */
export class ChapterNode extends Chapter {
  constructor(chapter: ChapterInit, options: DomainTreeOptions = {}) {
    super(chapter, options)
  }
}

/** Mutable chunk view; tokens require an injected tokenizer. */
export class ChunkNode extends Chunk {
  constructor(chunk: ChunkInit, options: DomainTreeOptions = {}) {
    super(chunk, options)
  }
}

/** Mutable paragraph view. */
export class ParagraphNode extends Paragraph {
  constructor(paragraph: ParagraphInit, options: DomainTreeOptions = {}) {
    super(paragraph, options)
  }
}

/** Mutable line view; words are derived on demand from the current text. */
export class LineNode extends ParagraphLine {
  constructor(line: ParagraphLineInit, options: DomainTreeOptions = {}) {
    super(line, options)
  }
}

/** Mutable word view backed by its line; `text` writes through to the line text. */
export class WordNode extends LineWord {
  constructor(line: ParagraphLine, wordIndex: number) {
    const span = line.words()[wordIndex]
    super(
      {
        id: `${line.id}:w${wordIndex}`,
        paragraphId: line.paragraphId,
        lineId: line.id,
        text: span?.text ?? '',
        index: wordIndex,
      },
      line,
      wordIndex,
    )
  }
}

/** Alternate chunk descent token; text is mutable on the node snapshot. */
export class TokenNode extends Token {}

/** Normalize a {@link Chapter} (or constructor input) into a {@link ChapterNode}. */
export function chapterTree(
  chapter: Chapter | ChapterInit,
  opts: DomainTreeOptions = {},
): ChapterNode {
  return new ChapterNode(chapter instanceof Chapter ? chapter.toInit() : chapter, opts)
}

/** Adapt a {@link Chapter} (or constructor input) into the read-side {@link ChapterBody} view. */
export function chapterBody(
  chapter: Chapter | ChapterInit,
  opts: DomainTreeOptions = {},
): ChapterBody {
  return chapterTree(chapter, opts).body()
}

/** Adapt markdown (`# Title` + body) into the read-side {@link ChapterBody} view. */
export function chapterBodyFromMarkdown(
  markdown: string,
  chapter: ChapterTreeInput,
  opts: DomainTreeOptions = {},
): ChapterBody {
  return parseChapterTree(markdown, chapter, opts).body()
}

/** Parse markdown (`# Title` + body) into a {@link ChapterNode}. */
export function parseChapterTree(
  markdown: string,
  chapter: ChapterTreeInput,
  opts: DomainTreeOptions = {},
): ChapterNode {
  return new ChapterNode({ ...chapter, text: markdown }, opts)
}
