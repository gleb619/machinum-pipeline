import { defineComposableTool, defineTool, getVariable, setVariable, withItem } from '@mt/core'
import type { Exchange, ToolContext } from '@mt/core'
import matter from 'gray-matter'

import { appendMdOutput } from '../core/md-outputs.js'
import { formatString } from './md-formatter.js'

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
  /** Chapter number from frontmatter; `undefined` when absent or non-numeric (0 is kept). */
  number: number | undefined
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

  if (doc.number !== undefined) {
    lines.push(`number: ${doc.number}`)
  }

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
 *
 * Note: frontmatter is kept as raw YAML (not fed to remark) to preserve
 * exact formatting. Only the body + title are run through formatString.
 */
export async function writeChapterDoc(doc: ChapterDoc): Promise<string> {
  const parts: string[] = []

  parts.push(serializeFrontmatter(doc))
  parts.push('')
  parts.push(`# ${doc.title}`)

  for (const paragraph of doc.body) {
    if (paragraph.lines.length === 0) continue
    parts.push('')
    parts.push(paragraph.lines.join('\n'))
  }

  parts.push('')
  // Only format the body (not the frontmatter YAML block, which remark would mangle)
  const bodyStart = parts.indexOf(`# ${doc.title}`)
  const frontmatterLines = parts.slice(0, bodyStart)
  const bodyLines = parts.slice(bodyStart)
  const rawFrontmatter = frontmatterLines.join('\n')
  const rawBody = bodyLines.join('\n')

  const formattedBodyResult = await formatString(rawBody)
  const formattedBody = formattedBodyResult.formatted

  // Remove leading blank line that formatString may add before the heading
  return `${rawFrontmatter}\n${formattedBody}`
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

function extractTitle(content: string): { title: string; bodyStartLine: number } {
  const lines = content.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string
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

  const n = Number(data.number)

  return {
    title,
    number: Number.isFinite(n) ? n : undefined,
    series: data.series ? String(data.series) : undefined,
    warnings: normalizeWarnings(data.warnings),
    body,
  }
}

// ---------------------------------------------------------------------------
// Tool
// ---------------------------------------------------------------------------

/** Variable holding the built {@link ChapterDoc}. */
export const VAR_CHAPTER_DOC = 'chapterDoc'

export interface ChapterDocToolInput {
  title: string
  body: string | ChapterDocParagraph[]
  number?: number
  series?: string
  warnings?: ChapterDocWarning[]
}

/** Slot `build`: chapter input -> YAML-frontmatter markdown; records the `chapterDoc` variable. */
export const chapterDocBuild = defineTool<ChapterDocToolInput, string>({
  name: 'chapter-doc-build',
  version: '1.0.0',
  mdDescription: 'Serializes chapter metadata into YAML-frontmatter markdown.',

  async invoke(env: Exchange<ChapterDocToolInput>, _ctx: ToolContext): Promise<Exchange<string>> {
    const input = env.item

    // No default: an absent number stays `undefined` so the frontmatter omits it
    // and downstream tools (chapterIndexer, emit filename) fall back to the
    // heading/title match instead of colliding on chapter1.md.
    const number =
      input.number ??
      (env.meta?.chapterNum as number | undefined) ??
      (env.meta?.chapter as number | undefined)

    const series =
      input.series ??
      getVariable<string>(env, 'chapterSeries') ??
      (env.meta?.chapterSeries as string | undefined)

    const warnings =
      input.warnings ?? normalizeWarnings(getVariable(env, 'warnings') ?? env.meta?.warnings)

    const doc: ChapterDoc = {
      title: input.title,
      number,
      series,
      warnings,
      body: normalizeBody(input.body),
    }

    const formatted = await writeChapterDoc(doc)
    return setVariable(withItem(env, formatted), VAR_CHAPTER_DOC, doc)
  },
})

/** Slot `emit`: only when meta carries a chapter number; intent targets the md:// root. */
export const chapterDocEmit = defineTool<string, string>({
  name: 'chapter-doc-emit',
  version: '1.0.0',
  mdDescription: "Appends item markdown to the mdOutputs variable as 'chapter' in .",
  async invoke(ex: Exchange<string>) {
    if (ex.meta?.chapterNum === undefined && ex.meta?.chapter === undefined) return ex
    const doc = getVariable<ChapterDoc>(ex, VAR_CHAPTER_DOC)
    const number =
      doc?.number ??
      (ex.meta?.chapterNum as number | undefined) ??
      (ex.meta?.chapter as number | undefined)
    if (number === undefined) {
      throw new Error(
        'chapter-doc-emit: cannot build output filename: no chapter number known ' +
          '(frontmatter `number` and meta.chapterNum/meta.chapter are all absent)',
      )
    }
    return appendMdOutput(ex, {
      name: 'chapter',
      subdir: '',
      filename: `chapter${number}.md`,
      content: ex.item,
    })
  },
})

/** Slots: `build`, `emit`. Override with `chapterDoc.with({ emit: myTool })`. */
export const chapterDoc = defineComposableTool<ChapterDocToolInput, string, 'build' | 'emit'>({
  name: 'chapter-doc',
  version: '1.0.0',
  mdDescription:
    'Serializes chapter metadata (title, number, warnings, body) into YAML-frontmatter markdown.',
  slots: { build: chapterDocBuild, emit: chapterDocEmit },
})
