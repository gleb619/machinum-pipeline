import { parseCsvRows, readDoc, writeDoc } from '../normalization/schema-doc.js'
import type { SchemaDocEnvelope, SchemaDocMetadata } from '../normalization/schema-doc.js'

/** The chapter as an extraction tool sees it: title, full body text, parsed document. */
export interface ChapterSource {
  title: string
  body: string
  doc: SchemaDocEnvelope
}

/**
 * Parses the incoming item (plain chapter markdown or a schema-doc) and exposes the
 * chapter text the LLM must reason over. `doc.summary` holds the whole body for a
 * plain chapter, so it doubles as the deterministic summary fallback.
 */
export function readChapter(item: string): ChapterSource {
  const doc = readDoc(item)
  return { title: doc.title, body: doc.summary, doc }
}

/** Values available as `{{name}}` placeholders in every extraction prompt. */
export function chapterVars(
  source: ChapterSource,
  extra?: Record<string, string | number>,
): Record<string, string | number> {
  return {
    title: source.title,
    body: source.body,
    chapter: source.doc.metadata.chapter,
    wordCount: source.doc.metadata.wordCount,
    tokenCount: source.doc.metadata.tokenCount,
    charLength: source.doc.metadata.charLength,
    ...extra,
  }
}

/** Renders `{{name}}` placeholders; unknown placeholders are left verbatim. */
export function renderPrompt(
  template: string,
  vars: Record<string, string | number | undefined>,
): string {
  return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (match, name: string) => {
    const value = vars[name]
    return value === undefined ? match : String(value)
  })
}

/** Returns the inside of a ```` ```lang ```` fence, or the input when it is not fenced. */
export function stripCodeFence(content: string, lang?: string): string {
  const fence = /^```[ \t]*\w*[ \t]*\n([\s\S]*?)\n?[ \t]*```[ \t]*$/.exec(content.trim())
  if (!fence) {
    return content.trim()
  }
  const inner = fence[1] ?? ''
  if (!lang) {
    return inner.trim()
  }
  const tag = /^```[ \t]*(\w+)/.exec(content.trim())?.[1]
  return tag?.toLowerCase() === lang.toLowerCase() ? inner.trim() : content.trim()
}

/**
 * Parses LLM CSV output into entities. Tolerates a missing `index,name` header,
 * an absent index column, and names containing commas.
 */
export function parseEntityRows(code: string): { index: number; name: string }[] {
  const rows = parseCsvRows(stripCodeFence(code, 'csv'))
  const entities: { index: number; name: string }[] = []

  for (const [position, row] of rows.entries()) {
    const cells = row.map((cell) => cell.trim()).filter((cell) => cell.length > 0)
    if (cells.length === 0) continue

    const header = cells.join(',').toLowerCase()
    if (position === 0 && header.replace(/\s/g, '') === 'index,name') continue
    if (position === 0 && header === 'name') continue

    const first = cells[0] ?? ''
    const index = Number(first)
    const hasIndex = cells.length > 1 && Number.isInteger(index) && index > 0
    const name = hasIndex ? cells.slice(1).join(',') : first
    entities.push({ index: hasIndex ? index : entities.length + 1, name })
  }

  return entities
}

/** Parses LLM vocabulary output: CSV, newline-, or comma-separated terms, lowercased and deduplicated. */
export function parseWordList(code: string): string[] {
  const stripped = stripCodeFence(code, 'csv')
  const cells = stripped
    .split(/[\n,;]+/)
    .map((cell) =>
      cell
        .trim()
        .replace(/^[-*\d.)\s]+/, '')
        .replace(/^["'`]+|["'`]+$/g, '')
        .trim(),
    )
    .filter((cell) => cell.length > 0 && cell.length <= 64)

  const header = cells[0]?.toLowerCase()
  const body = header === 'word' || header === 'words' ? cells.slice(1) : cells

  const seen = new Set<string>()
  const words: string[] = []
  for (const cell of body) {
    const word = cell.toLowerCase()
    if (seen.has(word)) continue
    seen.add(word)
    words.push(word)
  }
  return words
}

/** Parses a Metadata table or CSV row into the four schema-doc counters. */
export function parseMetadataRow(code: string): SchemaDocMetadata | undefined {
  const stripped = stripCodeFence(code)
  const line = stripped
    .split('\n')
    .map((row) => row.trim())
    .filter((row) => row.length > 0 && !/^\|?[ \t]*[-:]+[ \t]*\|/.test(row))
    .pop()
  if (!line) {
    return undefined
  }

  const cells = line
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split(/[,|]/)
    .map((cell) => cell.trim())
  if (cells.length < 4) {
    return undefined
  }

  const header = cells.join(' ').toLowerCase()
  if (/chapter|wordcount/.test(header) && cells.some((cell) => !/^\d+$/.test(cell))) {
    return undefined
  }

  const numbers = cells.slice(0, 4).map((cell) => Number(cell))
  if (!numbers.every((value) => Number.isFinite(value) && value >= 0)) {
    return undefined
  }
  const [chapter, wordCount, tokenCount, charLength] = numbers
  if (
    chapter === undefined ||
    wordCount === undefined ||
    tokenCount === undefined ||
    charLength === undefined
  ) {
    return undefined
  }

  return { chapter, wordCount, tokenCount, charLength }
}

/**
 * Validates that a candidate section survives the mdshape read/write layer:
 * writes it into a schema-doc, parses it back, and compares. Returns a rejection
 * reason (fed to the retry loop) or `undefined` when the content is usable.
 */
export function roundTripIssue(
  candidate: SchemaDocEnvelope,
  select: (doc: SchemaDocEnvelope) => unknown,
  label: string,
): string | undefined {
  const expected = select(candidate)
  let parsed: SchemaDocEnvelope
  try {
    parsed = readDoc(writeDoc(candidate))
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return `${label} cannot be written into a schema-doc: ${message}`
  }
  if (JSON.stringify(expected) !== JSON.stringify(select(parsed))) {
    return `${label} does not survive a schema-doc round-trip - it likely contains markdown headings or a '## ' section marker`
  }
  return undefined
}

/** Builds the deterministic metadata row from run meta and the document itself. */
export function metadataGroundTruth(
  meta: Record<string, unknown> | undefined,
  source: ChapterSource,
  item: string,
): SchemaDocMetadata {
  const doc = source.doc.metadata
  const fromMeta = (value: unknown) =>
    typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined

  const chapterValue = fromMeta(meta?.chapterNum) ?? fromMeta(meta?.chapter)
  const wordCountValue = fromMeta(meta?.wordCount)
  const tokenCountValue = fromMeta(meta?.tokenCount)

  return {
    chapter: chapterValue ?? (doc.chapter > 0 ? doc.chapter : 1),
    wordCount: wordCountValue ?? (doc.wordCount > 0 ? doc.wordCount : countWords(source.body)),
    tokenCount: tokenCountValue ?? doc.tokenCount,
    charLength: fromMeta(meta?.charLength) ?? (doc.charLength || item.length),
  }
}

export function countWords(text: string): number {
  return text.split(/\s+/).filter(Boolean).length
}

/**
 * The most frequent substantive words of a text, used to check that an LLM answer
 * actually covers the chapter instead of paraphrasing something unrelated.
 */
export function frequentTerms(text: string, limit = 20): string[] {
  const counts = new Map<string, number>()
  for (const word of text.toLowerCase().split(/[^a-z0-9']+/)) {
    if (word.length < 4) continue
    counts.set(word, (counts.get(word) ?? 0) + 1)
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([word]) => word)
}
