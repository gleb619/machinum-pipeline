import {
  annotate,
  category,
  defineComposableTool,
  defineTool,
  setVariable,
  tool,
  withItem,
} from '@mt/core'
import type { Chapter, Exchange, ToolContext } from '@mt/core'
import { readChapterDoc, toChapterBody } from './chapter-doc.js'
import type { ChapterBodyInput, ChapterDoc } from './chapter-doc.js'

/** Completeness/ordering findings reported by the validator. */
export type BookWarningCode =
  | 'GAP'
  | 'DUPLICATE_NUMBER'
  | 'OUT_OF_ORDER'
  | 'EMPTY_BODY'
  | 'DUPLICATE_TITLE'
  | 'DUPLICATE_PARAGRAPH'

/** A single finding: machine-readable code, the chapter it belongs to, a human message. */
export interface BookWarning {
  code: BookWarningCode
  chapterNumber?: number
  message: string
}

/** One TOC line: chapter number, chapter title and the anchor of its heading. */
export interface BookTocEntry {
  number: number | undefined
  title: string
  anchor: string
}

/** The compiled book: chapters, generated TOC, validation findings. */
export interface BookDoc {
  title: string
  chapters: ChapterDoc[]
  toc: BookTocEntry[]
  warnings: BookWarning[]
}

/** Chapter input: a chapter document, raw chapter markdown, or a domain chapter. */
export type ChapterInput = ChapterDoc | string | Chapter

export interface BookCompilerOptions {
  title?: string
  chapters?: ChapterInput[] | ChapterInput
}

/** Accepted shapes: an options object, a list of chapters, or a single chapter. */
export type BookCompilerInput = BookCompilerOptions | ChapterInput[] | ChapterInput

/** Variable carrying the compiled book document (TOC + warnings) to the `book://` target. */
export const VAR_BOOK = 'book'

const FNV64_OFFSET = 0xcbf29ce484222325n
const FNV64_PRIME = 0x100000001b3n
const FNV64_MASK = 0xffffffffffffffffn

/** 64-bit FNV-1a hash, hex encoded. */
function fnv1a64(text: string): string {
  let hash = FNV64_OFFSET
  for (let i = 0; i < text.length; i++) {
    hash ^= BigInt(text.charCodeAt(i))
    hash = (hash * FNV64_PRIME) & FNV64_MASK
  }
  return hash.toString(16).padStart(16, '0')
}

/** Lowercase, strip punctuation, collapse whitespace — so near-duplicates hash alike. */
function normalizeText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** GitHub-style anchor for a heading. */
function toAnchor(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .trim()
    .replace(/\s+/g, '-')
}

/** Heading text of a chapter — falls back to the chapter number, then to a placeholder. */
function headingText(chapter: ChapterDoc): string {
  const title = chapter.chapter.title.trim()
  if (title) return title
  return chapter.number !== undefined ? `Chapter ${chapter.number}` : 'Untitled Chapter'
}

/** Body paragraphs of a chapter document (blank-line separated). */
function bodyParagraphs(chapter: ChapterDoc): string[] {
  return chapter.chapter.body
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph.length > 0)
}

/** Chapter number from the heading, mirroring the `chapter-indexer` fallback. */
function numberFromTitle(title: string): number | undefined {
  const match = title.match(/Chapter\s+(\d+)/i)
  if (!match?.[1]) return undefined
  const n = Number(match[1])
  return Number.isFinite(n) ? n : undefined
}

function buildToc(chapters: ChapterDoc[]): BookTocEntry[] {
  return chapters.map((chapter) => {
    const title = headingText(chapter)
    return { number: chapter.number, title, anchor: toAnchor(title) }
  })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function toWarnings(value: unknown): ChapterDoc['warnings'] {
  return Array.isArray(value) ? (value as ChapterDoc['warnings']) : []
}

/** Coerce one input entry into a chapter document. */
function toChapterDoc(raw: unknown): ChapterDoc | undefined {
  if (typeof raw === 'string') {
    const parsed = readChapterDoc(raw)
    return { ...parsed, number: parsed.number ?? numberFromTitle(parsed.chapter.title) }
  }
  if (!isRecord(raw)) return undefined

  // Already a ChapterDoc: { chapter: Chapter, number?, series?, warnings?, meta? }.
  if (isRecord(raw.chapter) && typeof raw.chapter.body === 'string') {
    const chapter = raw.chapter as unknown as Chapter
    return {
      number:
        finiteNumber(raw.number) ??
        finiteNumber(raw.index) ??
        numberFromTitle(String(chapter.title ?? '')),
      series: typeof raw.series === 'string' ? raw.series : undefined,
      warnings: toWarnings(raw.warnings),
      meta: isRecord(raw.meta) ? raw.meta : undefined,
      chapter,
    }
  }

  // Domain chapter / legacy document-like record: title + body, `index` is its chapter number.
  const title = String(raw.title ?? '')
  const number = finiteNumber(raw.number) ?? finiteNumber(raw.index) ?? numberFromTitle(title)
  const chapter: Chapter = {
    id: typeof raw.id === 'string' ? raw.id : `chapter-${number ?? 0}`,
    bookId: typeof raw.bookId === 'string' ? raw.bookId : 'book',
    title,
    body: toChapterBody(raw.body as ChapterBodyInput),
  }
  return {
    number,
    series: typeof raw.series === 'string' ? raw.series : undefined,
    warnings: toWarnings(raw.warnings),
    chapter,
  }
}

/** Read chapters and the optional book title out of the exchange item. */
function readInput(env: Exchange<BookCompilerInput>): { chapters: ChapterDoc[]; title?: string } {
  const item = env.item as unknown
  const title = isRecord(item) && typeof item.title === 'string' ? item.title : undefined
  const raw = isRecord(item) && 'chapters' in item ? item.chapters : item
  const list = Array.isArray(raw) ? raw : [raw]
  const chapters: ChapterDoc[] = []
  for (const entry of list) {
    const chapter = toChapterDoc(entry)
    if (chapter) chapters.push(chapter)
  }
  return { chapters, title }
}

function countWords(chapters: ChapterDoc[]): number {
  let count = 0
  for (const chapter of chapters) {
    count += chapter.chapter.body.split(/\s+/).filter((word) => word.length > 0).length
  }
  return count
}

/** Deterministic checks — no LLM, no side effects. */
function validateChapters(chapters: ChapterDoc[]): BookWarning[] {
  const warnings: BookWarning[] = []

  const numberCounts = new Map<number, number>()
  for (const chapter of chapters) {
    if (chapter.number === undefined) continue
    numberCounts.set(chapter.number, (numberCounts.get(chapter.number) ?? 0) + 1)
  }
  for (const [number, count] of numberCounts) {
    if (count > 1) {
      warnings.push({
        code: 'DUPLICATE_NUMBER',
        chapterNumber: number,
        message: `Chapter number ${number} appears ${count} times`,
      })
    }
  }

  const uniqueNumbers = [...numberCounts.keys()].sort((a, b) => a - b)
  for (let i = 1; i < uniqueNumbers.length; i++) {
    const previous = uniqueNumbers[i - 1] as number
    const current = uniqueNumbers[i] as number
    for (let missing = previous + 1; missing < current; missing++) {
      warnings.push({
        code: 'GAP',
        chapterNumber: missing,
        message: `Chapter ${missing} is missing (between ${previous} and ${current})`,
      })
    }
  }

  let previousNumber: number | undefined
  for (const chapter of chapters) {
    if (chapter.number === undefined) continue
    if (previousNumber !== undefined && chapter.number < previousNumber) {
      warnings.push({
        code: 'OUT_OF_ORDER',
        chapterNumber: chapter.number,
        message: `Chapter ${chapter.number} comes after chapter ${previousNumber}`,
      })
    }
    previousNumber = chapter.number
  }

  for (const chapter of chapters) {
    const empty = chapter.chapter.body.trim().length === 0
    if (empty) {
      warnings.push({
        code: 'EMPTY_BODY',
        chapterNumber: chapter.number,
        message: `Chapter ${chapter.number ?? '?'} "${chapter.chapter.title}" has an empty body`,
      })
    }
  }

  const titleCounts = new Map<string, number>()
  for (const chapter of chapters) {
    const key = chapter.chapter.title.trim().toLowerCase()
    titleCounts.set(key, (titleCounts.get(key) ?? 0) + 1)
  }
  for (const chapter of chapters) {
    const key = chapter.chapter.title.trim().toLowerCase()
    if ((titleCounts.get(key) ?? 0) > 1) {
      warnings.push({
        code: 'DUPLICATE_TITLE',
        chapterNumber: chapter.number,
        message: `Duplicate chapter title "${chapter.chapter.title}"`,
      })
    }
  }

  const byHash = new Map<
    string,
    { chapterIndex: number; chapterNumber: number | undefined; chapterTitle: string }[]
  >()
  chapters.forEach((chapter, chapterIndex) => {
    for (const paragraph of bodyParagraphs(chapter)) {
      const normalized = normalizeText(paragraph)
      if (!normalized) continue
      const hash = fnv1a64(normalized)
      const occurrences = byHash.get(hash) ?? []
      occurrences.push({
        chapterIndex,
        chapterNumber: chapter.number,
        chapterTitle: chapter.chapter.title,
      })
      byHash.set(hash, occurrences)
    }
  })
  for (const occurrences of byHash.values()) {
    const distinct = new Set(occurrences.map((occurrence) => occurrence.chapterIndex))
    if (distinct.size < 2) continue
    const first = occurrences[0]
    const last = occurrences[occurrences.length - 1]
    if (!first || !last) continue
    warnings.push({
      code: 'DUPLICATE_PARAGRAPH',
      chapterNumber: last.chapterNumber,
      message: `Near-duplicate paragraph in "${first.chapterTitle}" and "${last.chapterTitle}"`,
    })
  }

  return warnings
}

/** Render the book as markdown. Pure — the waypoint target does the writing. */
function renderBook(doc: BookDoc): string {
  const lines: string[] = [
    '---',
    `title: ${JSON.stringify(doc.title)}`,
    `chapterCount: ${doc.chapters.length}`,
    `wordCount: ${countWords(doc.chapters)}`,
    '---',
    '',
    '## Table of Contents',
    '',
  ]
  for (const entry of doc.toc) {
    lines.push(`- [${entry.title}](#${entry.anchor})`)
  }
  for (const chapter of doc.chapters) {
    lines.push('')
    lines.push('---')
    lines.push('')
    lines.push(`# ${headingText(chapter)}`)
    for (const paragraph of bodyParagraphs(chapter)) {
      lines.push('')
      lines.push(paragraph)
    }
  }
  return `${lines.join('\n')}\n`
}

/** Slot `build`: chapter inputs -> BookDoc; records the `book` variable. */
export const bookCompilerBuild = defineTool<BookCompilerInput, BookDoc>({
  name: 'book-compiler-build',
  version: '1.0.0',
  mdDescription: 'Assembles chapter inputs into a BookDoc with a generated table of contents.',

  annotations: [
    tool('TL248', {
      name: 'book-compiler-build',
      description: 'Assembles chapter inputs into a BookDoc (title, chapters, TOC).',
      refs: [],
    }),
    category(['serializer']),
  ],
  async invoke(env: Exchange<BookCompilerInput>, _ctx: ToolContext): Promise<Exchange<BookDoc>> {
    const { chapters, title } = readInput(env)
    const doc: BookDoc = {
      title: title ?? 'Untitled Book',
      chapters,
      toc: buildToc(chapters),
      warnings: [],
    }
    return withItem(setVariable(env, VAR_BOOK, doc), doc)
  },
})

/** Slot `validate`: deterministic completeness/ordering report; records the `book` variable. */
export const bookCompilerValidate = defineTool<BookDoc, BookDoc>({
  name: 'book-compiler-validate',
  version: '1.0.0',
  mdDescription: 'Checks chapter numbering, ordering, titles and paragraph duplication.',

  annotations: [
    tool('TL249', {
      name: 'book-compiler-validate',
      description: 'Reports chapter gaps, duplicates, ordering problems and empty bodies.',
      refs: [],
    }),
    category(['validator']),
  ],
  async invoke(env: Exchange<BookDoc>, _ctx: ToolContext): Promise<Exchange<BookDoc>> {
    const doc = env.item
    const validated: BookDoc = {
      ...doc,
      warnings: [...doc.warnings, ...validateChapters(doc.chapters)],
    }
    return withItem(setVariable(env, VAR_BOOK, validated), validated)
  },
})

/** Slot `emit`: BookDoc -> markdown text. Pure — no writes. */
export const bookCompilerEmit = defineTool<BookDoc, string>({
  name: 'book-compiler-emit',
  version: '1.0.0',
  mdDescription: 'Renders the compiled book as one markdown document with a table of contents.',

  annotations: [
    tool('TL250', {
      name: 'book-compiler-emit',
      description: 'Renders the book as markdown with frontmatter, TOC and chapter separators.',
      refs: [],
    }),
    category(['serializer']),
  ],
  async invoke(env: Exchange<BookDoc>, _ctx: ToolContext): Promise<Exchange<string>> {
    return withItem(env, renderBook(env.item))
  },
})

/** Slots: `build`, `validate`, `emit`. Override with `bookCompiler.with({ emit: myTool })`. */
export const bookCompiler = annotate(
  defineComposableTool<BookCompilerInput, string, 'build' | 'validate' | 'emit'>({
    name: 'book-compiler',
    version: '1.0.0',
    mdDescription:
      'Assembles chapters into one book with a table of contents and a completeness report.',
    slots: { build: bookCompilerBuild, validate: bookCompilerValidate, emit: bookCompilerEmit },
  }),
  tool('TL251', {
    name: 'book-compiler',
    description:
      'Assembles chapters into one book with a table of contents and a completeness report.',
    refs: [],
  }),
  category(['serializer']),
)
