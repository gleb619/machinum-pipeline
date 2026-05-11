import { md } from '@markschema/mdshape'
import type { TypeMdIssue } from '@markschema/mdshape'
import { defineTool } from '@mt/core'
import type { Envelope, ToolContext } from '@mt/core'
import matter from 'gray-matter'

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
function parseCsvRows(code: string): string[][] {
  const lines = code.trim().split('\n')
  return lines.map((line) => line.split(','))
}

/** Format rows into CSV content. */
function formatCsv(rows: string[][]): string {
  return rows.map((row) => row.join(',')).join('\n')
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
  const body = lines.slice(1).join('\n').trim()

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

  const { title, summary, metadata, entities, vocabulary, schemaSection } =
    data ?? {}

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
    frontmatter:
      Object.keys(frontmatterData).length > 0 ? frontmatterData : undefined,
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

/** Tool: extracts the summary section and stores it in meta */
export const summaryTool = defineTool<string, string>({
  name: 'summary',
  version: '1.0.0',
  exec: 'inproc',
  async invoke(env: Envelope<string>, _ctx: ToolContext): Promise<Envelope<string>> {
    const doc = readDoc(env.item as string)
    return { ...env, meta: { ...env.meta, summary: doc.summary } }
  },
})

/** Tool: extracts entities from CSV block or falls back to defaults, stores in meta */
export const entitiesTool = defineTool<string, string>({
  name: 'entities',
  version: '1.0.0',
  exec: 'inproc',
  async invoke(env: Envelope<string>, _ctx: ToolContext): Promise<Envelope<string>> {
    const doc = readDoc(env.item as string)
    const entities = doc.entities.length > 0 ? doc.entities : [{ index: 1, name: 'chapter' }]
    return { ...env, meta: { ...env.meta, entities } }
  },
})

/** Tool: extracts or generates mermaid schema and stores it in meta */
export const schemaTool = defineTool<string, string>({
  name: 'schema',
  version: '1.0.0',
  exec: 'inproc',
  async invoke(env: Envelope<string>, _ctx: ToolContext): Promise<Envelope<string>> {
    const doc = readDoc(env.item as string)
    const titleText = doc.title.replace(/^Chapter \d+: /, '') || 'Unknown'
    const mermaid = doc.schema ?? `graph TD\n    ${titleText} --> Next`
    return { ...env, meta: { ...env.meta, schema: mermaid } }
  },
})

/** Tool: extracts metadata and stores it in meta */
export const metadataTool = defineTool<string, string>({
  name: 'metadata',
  version: '1.0.0',
  exec: 'inproc',
  async invoke(env: Envelope<string>, _ctx: ToolContext): Promise<Envelope<string>> {
    const doc = readDoc(env.item as string)
    return { ...env, meta: { ...env.meta, metadata: doc.metadata } }
  },
})

/** Tool: extracts vocabulary from summary, deduplicates, and updates known words */
export const vocabularyTool = defineTool<string, string>({
  name: 'vocabulary',
  version: '1.0.0',
  exec: 'inproc',
  async invoke(env: Envelope<string>, _ctx: ToolContext): Promise<Envelope<string>> {
    const doc = readDoc(env.item as string)
    const rawKnown = env.meta.knownWords
    const knownWords =
      Array.isArray(rawKnown) && rawKnown.every((w): w is string => typeof w === 'string')
        ? rawKnown
        : []
    const words = doc.summary.match(/\b[a-z]{2,}\b/gi) ?? []
    const lowerWords = words.map((w) => w.toLowerCase())
    const uniqueWords = [...new Set(lowerWords)]
    const knownSet = new Set(knownWords)
    const newWords = uniqueWords.filter((w) => !knownSet.has(w))
    const updatedKnownSet = [...new Set([...knownWords, ...newWords])]
    return {
      ...env,
      meta: {
        ...env.meta,
        vocabulary: newWords,
        knownWords: updatedKnownSet,
      },
    }
  },
})
