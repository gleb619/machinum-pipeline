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
 * Paragraph — a paragraph within a chapter.
 */
export interface Paragraph {
  id: string
  chapterId: string
  body: string
  index?: number
}

/**
 * Line — a line within a paragraph.
 */
export interface Line {
  id: string
  paragraphId: string
  text: string
  index?: number
}
