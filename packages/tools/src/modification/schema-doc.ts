import { md } from '@markschema/mdshape'
import type { TypeMdIssue } from '@markschema/mdshape'
import { defineComposableTool, defineTool, getVariable, withItem } from '@mt/core'
import type { Exchange, ToolContext } from '@mt/core'
import matter from 'gray-matter'

import { mdOutputEmitter } from '../core/md-outputs.js'

export interface SchemaDocMetadata {
  chapter: number
  wordCount: number
  tokenCount: number
  charLength: number
}

export interface SchemaDocEnvelope {
  title: string
  metadata: SchemaDocMetadata
  summary: string
  entities: { index: number; name: string }[]
  vocabulary: string[]
  schema?: string
  frontmatter?: Record<string, unknown>
}

// mdshape schema for structured schema-doc markdown:
// # Title
// ## Metadata  →  | chapter | wordCount | tokenCount | charLength |
// ## Summary   →  <paragraph>
// ## Entities  →  ```csv … ```
// ## Vocabulary →  ```csv … ```
// ## Schema    →  ```mermaid … ```
const schemaDocSchema = md.document({
  title: md.heading(1),
  metadata: md
    .section('Metadata')
    .tables(
      md.preprocess(
        (table: { rows: string[][] }) => {
          const row = table.rows[0]
          if (!row) return undefined
          return {
            chapter: row[0],
            wordCount: row[1],
            tokenCount: row[2],
            charLength: row[3],
          }
        },
        md.object({
          chapter: md.coerce.number(),
          wordCount: md.coerce.number(),
          tokenCount: md.coerce.number(),
          charLength: md.coerce.number(),
        }),
      ),
    )
    .optional(),
  summary: md.section('Summary').paragraph(),
  entities: md
    .section('Entities')
    .code(md.object({ code: md.string() }))
    .optional(),
  vocabulary: md
    .section('Vocabulary')
    .code(md.object({ code: md.string() }))
    .optional(),
  schemaSection: md
    .section('Schema')
    .code(md.object({ code: md.string() }))
    .optional(),
})

/** Parse CSV content into rows. */
export function parseCsvRows(code: string): string[][] {
  const lines = code.trim().split('\n')
  return lines.map((line) => line.split(','))
}

/** Format rows into CSV content. */
export function formatCsv(rows: string[][]): string {
  return rows.map((row) => row.join(',')).join('\n')
}

const ATX_HEADING_RE = /^#{1,6}[ \t]+(.+?)(?:[ \t]+#+)?[ \t]*$/
const FENCE_RE = /^[ \t]*(`{3,}|~{3,})/

/**
 * Rewrite body ATX headings as bold text. schema-doc sections are H2, so an
 * inner heading in a plain-markdown chapter would otherwise close `## Summary`
 * and drop everything after it (or leave it empty, which mdshape rejects).
 * Fenced code blocks are left verbatim.
 */
function demoteHeadings(body: string): string {
  const lines = body.split('\n')
  const result: string[] = []
  let openFence: string | undefined

  for (const line of lines) {
    const fence = FENCE_RE.exec(line)?.[1]
    if (fence) {
      const marker = fence.charAt(0)
      if (openFence === undefined) openFence = marker
      else if (openFence === marker) openFence = undefined
      result.push(line)
      continue
    }
    if (openFence) {
      result.push(line)
      continue
    }
    const headingText = ATX_HEADING_RE.exec(line)?.[1]?.trim()
    result.push(headingText ? `**${headingText}**` : line)
  }

  return result.join('\n')
}

/** Normalize simple markdown (`# Title\n\nBody`) into schema-doc format. */
function normalizeToSchemaDoc(content: string): string {
  const trimmed = content.trim()
  if (trimmed.includes('## Summary')) {
    return trimmed
  }

  const lines = trimmed.split('\n')
  const titleLine = lines[0]
  if (!titleLine?.startsWith('# ')) {
    throw new Error(
      'Invalid markdown: expected # Title at start or schema-doc format with ## Summary',
    )
  }

  const title = titleLine.slice(2).trim()
  const body = demoteHeadings(lines.slice(1).join('\n').trim())

  return [
    `# ${title}`,
    '',
    '## Metadata',
    '',
    '| chapter | wordCount | tokenCount | charLength |',
    '|---------|-----------|------------|------------|',
    '| 0 | 0 | 0 | 0 |',
    '',
    '## Summary',
    '',
    body,
    '',
  ].join('\n')
}

/** Parse a schema-doc markdown string into a typed envelope using mdshape. */
export function readDoc(markdown: string): SchemaDocEnvelope {
  const { data: frontmatterData, content } = matter(markdown)
  const normalized = normalizeToSchemaDoc(content)

  const issues: TypeMdIssue[] = []
  const data = schemaDocSchema.run(normalized, { issues, path: [] })

  const optionalSections = ['entities', 'vocabulary', 'schemaSection']
  const realIssues = issues.filter(
    (issue) =>
      !(
        issue.code === 'missing_section' &&
        issue.path.length === 1 &&
        optionalSections.includes(String(issue.path[0]))
      ),
  )

  if (realIssues.length > 0) {
    const formatted = realIssues
      .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
      .join('\n')
    throw new Error(`Failed to parse schema-doc markdown:\n${formatted}`)
  }

  const { title, summary, metadata, entities, vocabulary, schemaSection } = data ?? {}

  const metaRow = metadata?.[0]
  if (!metaRow) {
    throw new Error('Missing required Metadata section')
  }

  const parsedEntities = entities?.[0]?.code
    ? parseCsvRows(entities[0].code)
        .slice(1)
        .map((row) => ({
          index: Number(row[0]),
          name: row[1] ?? '',
        }))
    : []

  const parsedVocabulary = vocabulary?.[0]?.code
    ? parseCsvRows(vocabulary[0].code)
        .slice(1)
        .map((row) => row[0] ?? '')
        .filter(Boolean)
    : []

  return {
    title: title ?? '',
    metadata: {
      chapter: Number(metaRow.chapter),
      wordCount: Number(metaRow.wordCount),
      tokenCount: Number(metaRow.tokenCount),
      charLength: Number(metaRow.charLength),
    },
    summary: summary ?? '',
    entities: parsedEntities,
    vocabulary: parsedVocabulary,
    schema: schemaSection?.[0]?.code,
    frontmatter: Object.keys(frontmatterData).length > 0 ? frontmatterData : undefined,
  }
}

/** Reconstruct a schema-doc markdown string from a typed envelope. */
export function writeDoc(doc: SchemaDocEnvelope): string {
  const lines: string[] = []

  if (doc.frontmatter && Object.keys(doc.frontmatter).length > 0) {
    lines.push('---')
    for (const [key, value] of Object.entries(doc.frontmatter)) {
      lines.push(`${key}: ${typeof value === 'string' ? value : JSON.stringify(value)}`)
    }
    lines.push('---', '')
  }

  lines.push(`# ${doc.title}`, '')
  lines.push(
    '## Metadata',
    '',
    '| chapter | wordCount | tokenCount | charLength |',
    '|---------|-----------|------------|------------|',
    `| ${doc.metadata.chapter} | ${doc.metadata.wordCount} | ${doc.metadata.tokenCount} | ${doc.metadata.charLength} |`,
    '',
  )
  lines.push('## Summary', '', doc.summary, '')

  if (doc.entities.length > 0) {
    lines.push(
      '## Entities',
      '',
      '```csv',
      formatCsv([['index', 'name'], ...doc.entities.map((e) => [String(e.index), e.name])]),
      '```',
      '',
    )
  }

  if (doc.vocabulary.length > 0) {
    lines.push(
      '## Vocabulary',
      '',
      '```csv',
      formatCsv([['word'], ...doc.vocabulary.map((w) => [w])]),
      '```',
      '',
    )
  }

  if (doc.schema) {
    lines.push('## Schema', '', '```mermaid', doc.schema, '```', '')
  }

  return lines.join('\n')
}

function extractTitleFromInput(item: unknown, chapterNum: number): string {
  if (typeof item === 'string') {
    const firstLine = item.trim().split('\n')[0] || ''
    if (firstLine.startsWith('# ')) {
      return firstLine.slice(2).trim()
    }
  }
  const record = item as Record<string, unknown> | undefined
  if (record && typeof record.title === 'string') {
    return record.title
  }
  return `Chapter ${chapterNum}`
}

/** Slot `build`: exchange variables -> schema-doc markdown (pure, no mdOutputs). */
export const schemaDocBuild = defineTool<unknown, string>({
  name: 'schema-doc-build',
  version: '1.0.0',
  mdDescription: 'Builds schema-doc markdown from envelope metadata.',
  async invoke(env: Exchange<unknown>, _ctx: ToolContext): Promise<Exchange<string>> {
    const meta = (env.meta || {}) as Record<string, unknown>
    const chapterNum = schemaDocChapterNum(meta)
    const summary = getVariable<string>(env, 'summary') || ''
    const entities = getVariable<{ index: number; name: string }[]>(env, 'entities') || []
    const vocabulary = getVariable<string[]>(env, 'vocabulary') || []
    const schema = getVariable<string>(env, 'schema')
    const wordCount = getVariable<number>(env, 'wordCount') || 0
    const tokenCount = getVariable<number>(env, 'tokenCount') || 0
    const charLength =
      getVariable<number>(env, 'charLength') || (typeof env.item === 'string' ? env.item.length : 0)

    const doc: SchemaDocEnvelope = {
      title: extractTitleFromInput(env.item, chapterNum),
      metadata: { chapter: chapterNum, wordCount, tokenCount, charLength },
      summary,
      entities,
      vocabulary,
      schema,
    }

    return withItem(env, writeDoc(doc))
  },
})

function schemaDocChapterNum(meta: Record<string, unknown>): number {
  return (meta.chapterNum as number) || (meta.chapter as number) || 1
}

/** Slot `emit`: markdown -> `mdOutputs` intent for `<target-root>/schema`. */
export const schemaDocEmit = mdOutputEmitter({
  name: 'schema-doc',
  subdir: 'schema',
  filename: (meta) => `chapter${schemaDocChapterNum(meta)}.schema.md`,
  toolName: 'schema-doc-emit',
})

/**
 * Tool: builds a schema-doc markdown from meta and sets the mdOutputs variable for schema-doc writes.
 * Slots: `build`, `emit`. Override with `schemaDocWriter.with({ emit: myTool })`.
 */
export const schemaDocWriter = defineComposableTool<unknown, string, 'build' | 'emit'>({
  name: 'schema-doc-writer',
  version: '1.0.0',
  mdDescription:
    'Builds schema-doc markdown from envelope metadata. Sets the `mdOutputs` variable for writes.',
  slots: { build: schemaDocBuild, emit: schemaDocEmit },
})
