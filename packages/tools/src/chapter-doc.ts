import { defineTool } from '@mt/core'
import type { Envelope, MdOutputEntry, ToolContext } from '@mt/core'
import matter from 'gray-matter'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ChapterDocWarning {
  id: string | number
  text: string
}

export interface ChapterDocParagraph {
  lines: string[]
}

export interface ChapterDoc {
  title: string
  number: number
  series?: string
  warnings: ChapterDocWarning[]
  body: ChapterDocParagraph[]
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function yamlEscapeString(value: string): string {
  if (
    value.includes('\n') ||
    value.includes('"') ||
    value.includes(':') ||
    value.includes("'") ||
    value.startsWith(' ') ||
    value.endsWith(' ') ||
    /^[\-\?\:\,\[\]\{\}\#\&\*\!\|\>\'\"\%\@\`\s]/.test(value) ||
    /[\#\,\[\]\{\}\&\*\!\|\>\'\"\%\@\`]$/.test(value)
  ) {
    return JSON.stringify(value)
  }
  return value
}

function serializeFrontmatter(doc: ChapterDoc): string {
  const lines: string[] = ['---']

  lines.push(`number: ${doc.number}`)

  if (doc.series !== undefined && doc.series !== '') {
    lines.push(`series: ${yamlEscapeString(doc.series)}`)
  }

  if (doc.warnings.length > 0) {
    lines.push('warnings:')
    for (const w of doc.warnings) {
      lines.push(`  - id: ${typeof w.id === 'string' ? yamlEscapeString(w.id) : w.id}`)
      lines.push(`    text: ${yamlEscapeString(w.text)}`)
    }
  }

  lines.push('---')
  return lines.join('\n')
}

function normalizeWarnings(input: unknown): ChapterDocWarning[] {
  if (!input || !Array.isArray(input)) return []
  const result: ChapterDocWarning[] = []
  for (const w of input) {
    if (w && typeof w === 'object') {
      const id = (w as Record<string, unknown>).id
      const text = String((w as Record<string, unknown>).text ?? '')
      if (id !== undefined && id !== null && id !== '') {
        result.push({ id: typeof id === 'number' ? id : String(id), text })
      }
    }
  }
  return result
}

function normalizeBody(input: unknown): ChapterDocParagraph[] {
  if (typeof input === 'string') {
    let text = input
    if (text.startsWith('# ')) {
      const newlineIdx = text.indexOf('\n')
      text = newlineIdx >= 0 ? text.slice(newlineIdx + 1) : ''
    }
    const paragraphs = text.split(/\n\s*\n/).filter((p) => p.trim().length > 0)
    return paragraphs.map((p) => ({ lines: [p.trim().replace(/\s+/g, ' ')] }))
  }

  if (Array.isArray(input)) {
    return input
      .map((p) => {
        if (p && typeof p === 'object' && 'lines' in p) {
          const lines = Array.isArray(p.lines)
            ? p.lines.map((l: unknown) => String(l ?? '')).filter((l: string) => l.length > 0)
            : []
          return { lines }
        }
        if (typeof p === 'string') {
          return { lines: [p.trim()] }
        }
        return null
      })
      .filter((p): p is ChapterDocParagraph => p !== null && p.lines.length > 0)
  }

  return []
}

// ---------------------------------------------------------------------------
// Write
// ---------------------------------------------------------------------------

/**
 * Serialize a ChapterDoc into markdown.
 *
 * Output format:
 * ```markdown
 * ---
 * number: 1
 * series: chapter09.en.md, chapter10.en.md
 * warnings:
 *   - id: 1
 *     text: Type on line 2, with `HUIJKL` text
 * ---
 *
 * # Title
 *
 * Line one
 * Line two
 *
 * Next paragraph
 * next line
 * ```
 */
export function writeChapterDoc(doc: ChapterDoc): string {
  const parts: string[] = []

  parts.push(serializeFrontmatter(doc))
  parts.push('')
  parts.push(`# ${doc.title}`)

  for (const paragraph of doc.body) {
    if (paragraph.lines.length === 0) continue
    parts.push('')
    parts.push(paragraph.lines.join('  \n'))
  }

  parts.push('')
  return parts.join('\n')
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

function extractTitle(content: string): { title: string; bodyStartLine: number } {
  const lines = content.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    const trimmed = line.trim()
    if (trimmed.startsWith('# ')) {
      return { title: trimmed.slice(2).trim(), bodyStartLine: i + 1 }
    }
  }
  throw new Error('Failed to parse chapter markdown: no h1 title found')
}

function parseBody(content: string, bodyStartLine: number): ChapterDocParagraph[] {
  const allLines = content.split('\n')
  const bodyLines = allLines.slice(bodyStartLine)

  const paragraphs: ChapterDocParagraph[] = []
  let currentBlock: string[] = []

  for (const rawLine of bodyLines) {
    if (rawLine.trim().length === 0) {
      if (currentBlock.length > 0) {
        paragraphs.push(finishParagraph(currentBlock))
        currentBlock = []
      }
    } else {
      currentBlock.push(rawLine)
    }
  }

  if (currentBlock.length > 0) {
    paragraphs.push(finishParagraph(currentBlock))
  }

  return paragraphs
}

function finishParagraph(block: string[]): ChapterDocParagraph {
  const lines = block
    .map((line) => line.replace(/ {2}$/, '').trim())
    .filter((line) => line.length > 0)
  return { lines }
}

export function readChapterDoc(markdown: string): ChapterDoc {
  const { data, content } = matter(markdown)
  const { title, bodyStartLine } = extractTitle(content)
  const body = parseBody(content, bodyStartLine)

  return {
    title,
    number: Number(data.number) || 1,
    series: data.series ? String(data.series) : undefined,
    warnings: normalizeWarnings(data.warnings),
    body,
  }
}

// ---------------------------------------------------------------------------
// Tool
// ---------------------------------------------------------------------------

export interface ChapterDocToolInput {
  title: string
  body: string | ChapterDocParagraph[]
  number?: number
  series?: string
  warnings?: ChapterDocWarning[]
}

export const chapterDoc = defineTool<ChapterDocToolInput, string>({
  name: 'chapter-doc',
  version: '1.0.0',
  exec: 'inproc',

  async invoke(env: Envelope<ChapterDocToolInput>, _ctx: ToolContext): Promise<Envelope<string>> {
    const input = env.item

    const number =
      input.number ??
      (env.meta?.chapterNum as number | undefined) ??
      (env.meta?.chapter as number | undefined) ??
      1

    const series = input.series ?? (env.meta?.chapterSeries as string | undefined)

    const warnings = input.warnings ?? normalizeWarnings(env.meta?.warnings)

    const doc: ChapterDoc = {
      title: input.title,
      number,
      series,
      warnings,
      body: normalizeBody(input.body),
    }

    const formatted = writeChapterDoc(doc)

    const existing = (env.meta?.mdOutputs as MdOutputEntry[] | undefined) ?? []
    const mdOutputs: MdOutputEntry[] | undefined =
      env.meta?.chapterNum !== undefined || env.meta?.chapter !== undefined
        ? [
            ...existing,
            {
              name: 'chapter',
              dir: 'chapters/en',
              filename: `chapter${number}.md`,
              content: formatted,
            },
          ]
        : undefined

    const meta: Record<string, unknown> = {
      ...env.meta,
      chapterDoc: doc,
    }
    if (mdOutputs) {
      meta.mdOutputs = mdOutputs
    }

    return { item: formatted, meta }
  },
})
