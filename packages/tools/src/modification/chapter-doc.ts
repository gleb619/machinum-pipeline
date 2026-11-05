import {
  annotate,
  category,
  chapterTree as createChapterTree,
  defineComposableTool,
  defineTool,
  getVariable,
  setVariable,
  tool,
  withItem,
} from '@mt/core'
import type {
  Chapter,
  ChapterBody,
  ChapterNode,
  DomainTreeOptions,
  Exchange,
  ToolContext,
} from '@mt/core'
import matter from 'gray-matter'

import { appendMdOutput } from '../core/md-outputs.js'
import { ChapterMetadata } from './chapter-metadata.js'
import { formatString } from './md-formatter.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ChapterDocWarning {
  id: string | number
  text: string
}

/**
 * Chapter document: frontmatter (`number` / `series` / `warnings` / `meta`) plus the
 * domain {@link Chapter} carrying title + markdown body.
 */
export interface ChapterDoc {
  /** Chapter number from frontmatter; `undefined` when absent or non-numeric (0 is kept). */
  number: number | undefined
  series?: string
  warnings: ChapterDocWarning[]
  /** Extra frontmatter keys beyond `number` / `series` / `warnings`. */
  meta?: Record<string, unknown>
  /** Content: `chapter.title` is the H1, `chapter.body` the markdown body. */
  chapter: Chapter
}

/** Legacy paragraph-array body (`{ lines: string[] }[]`); deprecated adapter input. */
export interface LegacyChapterParagraph {
  lines: string[]
}

/** Body content accepted by tools: markdown, domain chapter, tree/body view, or legacy paragraphs. */
export type ChapterBodyInput =
  | string
  | Chapter
  | ChapterNode
  | ChapterBody
  | LegacyChapterParagraph[]

const DOC_CHAPTER_ID = 'chapter-doc'
const DOC_BOOK_ID = 'chapter-doc'

/** Chapter docs have no chunk layer: the whole body is a single chunk so `---` lines stay plain lines. */
function chapterDocChunks(body: string): string[] {
  return body.trim().length > 0 ? [body] : []
}

function legacyParagraphsToText(paragraphs: LegacyChapterParagraph[]): string {
  return paragraphs
    .map((paragraph) =>
      (Array.isArray(paragraph.lines) ? paragraph.lines : [])
        .map((line) => String(line ?? ''))
        .filter((line) => line.length > 0)
        .join('\n'),
    )
    .filter((text) => text.length > 0)
    .join('\n\n')
}

/**
 * Single body normalization point: raw markdown (leading `# title` stripped), legacy
 * paragraph array, domain `Chapter`, tree node or {@link ChapterBody} -> markdown body text.
 */
export function toChapterBody(input: ChapterBodyInput | null | undefined): string {
  if (input === null || input === undefined) return ''

  if (typeof input === 'string') {
    let text = input
    if (text.startsWith('# ')) {
      const newlineIdx = text.indexOf('\n')
      text = newlineIdx >= 0 ? text.slice(newlineIdx + 1) : ''
    }
    return text.trim()
  }

  if (Array.isArray(input)) return legacyParagraphsToText(input)

  if ('body' in input && typeof input.body === 'string') return input.body
  if ('text' in input && typeof input.text === 'string') return input.text
  return ''
}

/**
 * `ChapterDoc` with fluent {@link metadata} (frontmatter) and {@link chapterTree}
 * (title + body) handles. Content lives in one internal {@link ChapterNode}: tree
 * mutations (`line.text`, `setText`, `insertLine`, ...) are reflected in the
 * {@link chapter} snapshot and in `writeChapterDoc` output. Methods live on the
 * prototype / `#`-private fields so the enumerable shape stays identical to a
 * plain `ChapterDoc` (existing `toEqual`/spread sites keep working).
 */
export class ChapterDocNode implements ChapterDoc {
  number: number | undefined
  series?: string
  warnings: ChapterDocWarning[]
  meta?: Record<string, unknown>
  declare chapter: Chapter

  #treeOptions: DomainTreeOptions
  #tree: ChapterNode

  constructor(init: ChapterDoc) {
    this.number = init.number
    this.series = init.series
    this.warnings = init.warnings
    if (init.meta && Object.keys(init.meta).length > 0) {
      this.meta = { ...init.meta }
    }
    this.#treeOptions = { splitChunks: chapterDocChunks }
    this.#tree = createChapterTree(init.chapter, this.#treeOptions)
    Object.defineProperty(this, 'chapter', {
      enumerable: true,
      configurable: true,
      get: () => this.#tree.toChapter(),
      set: (value: Chapter) => {
        this.#tree = createChapterTree(value, this.#treeOptions)
      },
    })
  }

  metadata(): ChapterMetadata {
    return new ChapterMetadata(this)
  }

  /**
   * Mutable {@link ChapterNode} view over title + body. Mutations are written
   * through to this doc. Pass `opts` (e.g. `tokenize`) to rebuild the view with
   * extra {@link DomainTreeOptions}; current content is preserved.
   */
  chapterTree(opts: DomainTreeOptions = {}): ChapterNode {
    if (Object.keys(opts).length > 0) {
      this.#treeOptions = { ...this.#treeOptions, ...opts }
      this.#tree = createChapterTree(this.#tree.toChapter(), this.#treeOptions)
    }
    return this.#tree
  }
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

function formatScalar(value: unknown): string {
  if (value === null) return 'null'
  if (typeof value === 'boolean' || typeof value === 'number') return String(value)
  if (typeof value === 'string') return yamlEscapeString(value)
  // YAML cannot represent functions/symbols/bigint natively — JSON-stringify, never drop.
  return JSON.stringify(value)
}

/** Serialize a YAML value as lines under `key` at the given indent. Nested object keys are sorted. */
function formatYamlEntry(key: string, value: unknown, indent: number): string[] {
  const pad = ' '.repeat(indent)

  if (value === undefined) return []

  if (
    value === null ||
    typeof value === 'boolean' ||
    typeof value === 'number' ||
    typeof value === 'string'
  ) {
    return [`${pad}${key}: ${formatScalar(value)}`]
  }

  if (Array.isArray(value)) {
    if (value.length === 0) return [`${pad}${key}: []`]
    const lines = [`${pad}${key}:`]
    for (const item of value) {
      if (item !== null && typeof item === 'object' && !Array.isArray(item)) {
        const obj = item as Record<string, unknown>
        const keys = Object.keys(obj).sort()
        if (keys.length === 0) {
          lines.push(`${pad}  - {}`)
          continue
        }
        let first = true
        for (const k of keys) {
          const sub = formatYamlEntry(k, obj[k], indent + 4)
          if (sub.length === 0) continue
          if (first) {
            const [head, ...rest] = sub
            lines.push(`${pad}  - ${head?.trimStart() ?? ''}`)
            lines.push(...rest)
            first = false
          } else {
            lines.push(...sub)
          }
        }
      } else if (Array.isArray(item)) {
        lines.push(`${pad}  - ${JSON.stringify(item)}`)
      } else {
        lines.push(`${pad}  - ${formatScalar(item)}`)
      }
    }
    return lines
  }

  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>
    const keys = Object.keys(obj).sort()
    if (keys.length === 0) return [`${pad}${key}: {}`]
    const lines = [`${pad}${key}:`]
    for (const k of keys) {
      lines.push(...formatYamlEntry(k, obj[k], indent + 2))
    }
    return lines
  }

  return [`${pad}${key}: ${JSON.stringify(value)}`]
}

function serializeWarnings(warnings: ChapterDocWarning[]): string[] {
  const fields: string[] = ['warnings:']
  for (const w of warnings) {
    fields.push(`  - id: ${typeof w.id === 'string' ? yamlEscapeString(w.id) : w.id}`)
    fields.push(`    text: ${yamlEscapeString(w.text)}`)
  }
  return fields
}

function serializeFrontmatter(doc: ChapterDoc): string {
  const fields: string[] = []

  if (doc.number !== undefined) {
    fields.push(`number: ${doc.number}`)
  }

  if (doc.series !== undefined && doc.series !== '') {
    fields.push(`series: ${yamlEscapeString(doc.series)}`)
  }

  if (doc.warnings.length > 0) {
    fields.push(...serializeWarnings(doc.warnings))
  }

  // Extra keys alphabetically — insertion order must never leak into output.
  if (doc.meta) {
    for (const key of Object.keys(doc.meta).sort()) {
      if (key === 'number' || key === 'series' || key === 'warnings') continue
      fields.push(...formatYamlEntry(key, doc.meta[key], 0))
    }
  }

  if (fields.length === 0) return ''
  return ['---', ...fields, '---'].join('\n')
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

function extractExtraMeta(data: Record<string, unknown>): Record<string, unknown> | undefined {
  const meta: Record<string, unknown> = {}
  for (const key of Object.keys(data)) {
    if (key === 'number' || key === 'series' || key === 'warnings') continue
    meta[key] = data[key]
  }
  return Object.keys(meta).length > 0 ? meta : undefined
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
 * Known keys (`number`, `series`, `warnings`) come first; extra `meta` keys follow
 * alphabetically. Values YAML cannot represent natively are JSON-stringified.
 */
export async function writeChapterDoc(doc: ChapterDoc): Promise<string> {
  const title = doc.chapter.title
  const body = doc.chapter.body
  const parts: string[] = []

  const frontmatter = serializeFrontmatter(doc)
  if (frontmatter) parts.push(frontmatter)
  parts.push('')
  parts.push(`# ${title}`)

  if (body.trim().length > 0) {
    parts.push('')
    parts.push(body)
  }

  parts.push('')
  // Only format the body (not the frontmatter YAML block, which remark would mangle)
  const bodyStart = parts.indexOf(`# ${title}`)
  const frontmatterLines = parts.slice(0, bodyStart)
  const bodyLines = parts.slice(bodyStart)
  const rawFrontmatter = frontmatterLines.join('\n')
  const rawBody = bodyLines.join('\n')

  const formattedBodyResult = await formatString(rawBody)
  const formattedBody = formattedBodyResult.formatted

  // Remove leading blank line that formatString may add before the heading
  if (rawFrontmatter) {
    return `${rawFrontmatter}\n${formattedBody}`
  }
  return formattedBody.replace(/^\n+/, '')
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

/** Parse the body after `# title` into normalized paragraph text (tree-faithful, `---` stays a line). */
function parseBody(content: string, bodyStartLine: number, title: string): string {
  const bodyText = content.split('\n').slice(bodyStartLine).join('\n')
  const tree = createChapterTree(
    { id: DOC_CHAPTER_ID, bookId: DOC_BOOK_ID, title, body: bodyText },
    { splitChunks: chapterDocChunks },
  )
  return tree
    .paragraphs()
    .map((paragraph) => paragraph.body)
    .join('\n\n')
}

export function readChapterDoc(markdown: string): ChapterDocNode {
  const { data, content } = matter(markdown)
  const { title, bodyStartLine } = extractTitle(content)
  const body = parseBody(content, bodyStartLine, title)

  const n = Number(data.number)
  const dataRecord = data as Record<string, unknown>

  return new ChapterDocNode({
    number: Number.isFinite(n) ? n : undefined,
    series: data.series ? String(data.series) : undefined,
    warnings: normalizeWarnings(data.warnings),
    meta: extractExtraMeta(dataRecord),
    chapter: { id: DOC_CHAPTER_ID, bookId: DOC_BOOK_ID, title, body },
  })
}

// ---------------------------------------------------------------------------
// Tool
// ---------------------------------------------------------------------------

/** Variable holding the built {@link ChapterDoc}. */
export const VAR_CHAPTER_DOC = 'chapterDoc'

export interface ChapterDocToolInput {
  title: string
  /** Body content: markdown, domain `Chapter`, tree/node view, or legacy paragraph array. */
  body: ChapterBodyInput
  number?: number
  series?: string
  warnings?: ChapterDocWarning[]
  /** Extra frontmatter keys; known keys here override generated `number`/`series`/`warnings`. */
  meta?: Record<string, unknown>
}

function buildChapterDocFromInput(
  input: ChapterDocToolInput,
  number: number | undefined,
  series: string | undefined,
  warnings: ChapterDocWarning[],
): ChapterDocNode {
  let resolvedNumber = number
  let resolvedSeries = series
  let resolvedWarnings = warnings
  const extra: Record<string, unknown> = {}

  if (input.meta) {
    for (const [key, value] of Object.entries(input.meta)) {
      if (key === 'number') {
        const n = typeof value === 'number' ? value : Number(value)
        resolvedNumber = Number.isFinite(n) ? n : undefined
      } else if (key === 'series') {
        resolvedSeries = value === undefined || value === '' ? undefined : String(value)
      } else if (key === 'warnings') {
        resolvedWarnings = normalizeWarnings(value)
      } else {
        extra[key] = value
      }
    }
  }

  return new ChapterDocNode({
    number: resolvedNumber,
    series: resolvedSeries,
    warnings: resolvedWarnings,
    meta: Object.keys(extra).length > 0 ? extra : undefined,
    chapter: {
      id: DOC_CHAPTER_ID,
      bookId: DOC_BOOK_ID,
      title: input.title,
      body: toChapterBody(input.body),
    },
  })
}

/** Slot `build`: chapter input -> YAML-frontmatter markdown; records the `chapterDoc` variable. */
export const chapterDocBuild = defineTool<ChapterDocToolInput, string>({
  name: 'chapter-doc-build',
  version: '1.0.0',
  mdDescription: 'Serializes chapter metadata into YAML-frontmatter markdown.',

  annotations: [
    tool('TL064', {
      name: 'chapter-doc-build',
      description: 'Serializes chapter metadata into YAML-frontmatter markdown.',
      refs: [],
    }),
    category(['serializer']),
  ],
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

    const doc = buildChapterDocFromInput(input, number, series, warnings)

    const formatted = await writeChapterDoc(doc)
    return setVariable(withItem(env, formatted), VAR_CHAPTER_DOC, doc)
  },
})

/** Slot `emit`: only when meta carries a chapter number; intent targets the md:// root. */
export const chapterDocEmit = defineTool<string, string>({
  name: 'chapter-doc-emit',
  version: '1.0.0',
  mdDescription: "Appends item markdown to the mdOutputs variable as 'chapter' in .",
  annotations: [
    tool('TL203', {
      name: 'chapter-doc-emit',
      description: 'Appends chapter markdown to the mdOutputs variable.',
      refs: [],
    }),
    category(['serializer']),
  ],
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
export const chapterDoc = annotate(
  defineComposableTool<ChapterDocToolInput, string, 'build' | 'emit'>({
    name: 'chapter-doc',
    version: '1.0.0',
    mdDescription:
      'Serializes chapter metadata (title, number, warnings, body) into YAML-frontmatter markdown.',
    slots: { build: chapterDocBuild, emit: chapterDocEmit },
  }),
  tool('TL202', {
    name: 'chapter-doc',
    description: 'Serializes chapter metadata into YAML-frontmatter markdown.',
    refs: [],
  }),
  category(['serializer']),
)

export { ChapterMetadata } from './chapter-metadata.js'
