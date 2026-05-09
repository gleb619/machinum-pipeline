import { createWriteStream, mkdirSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { SourceContext, TargetContext } from '@mt/core'
import type { Envelope, Source, Target } from '@mt/core'
import type { ParsedUri } from '@mt/core'
import { registry } from '@mt/core'
import matter from 'gray-matter'
import remarkParse from 'remark-parse'
import { unified } from 'unified'

export interface SchemaDocEnvelope {
  title: string
  summary: string
  entities: { index: number; name: string }[]
  schema?: string
  frontmatter?: Record<string, unknown>
}

/**
 * Schema Document Target — writes per-chapter schema documents.
 * URI path is the output directory base (e.g. 'schema-doc://./chapters/schema').
 * Each envelope is written to: <dir>/chapter<chapterNum>.schema.md
 * Content is assembled from meta fields (title from item, summary/entities/schema from meta).
 */
export function createSchemaDocTarget(uri: ParsedUri): Target<string> {
  const baseDir = uri.path || uri.host
  mkdirSync(baseDir, { recursive: true })

  return {
    uri: uri.raw,
    async open(_ctx: TargetContext): Promise<void> {
      // Directory already created in constructor
    },
    async write(env: Envelope<string>, _ctx: TargetContext): Promise<void> {
      const meta = (env.meta || {}) as Record<string, unknown>
      const chapterNum = (meta.chapterNum as number) || 0
      const summary = (meta.summary as string) || ''
      const entities = (meta.entities as { index: number; name: string }[]) || []
      const schema = meta.schema as string | undefined

      // Extract title from the markdown item
      const titleMatch = env.item.match(/^#\s*(.+)/m)
      const title = titleMatch ? titleMatch[1] : `Chapter ${chapterNum}`

      const filename = `chapter${chapterNum}.schema.md`
      const filePath = join(baseDir, filename)
      mkdirSync(dirname(filePath), { recursive: true })

      const lines: string[] = []
      lines.push(`# ${title}`)
      lines.push('')
      lines.push('## Summary')
      lines.push('')
      lines.push(summary)
      lines.push('')
      lines.push('## Entities')
      lines.push('')
      lines.push('| Index | Name |')
      lines.push('|:------|------|')
      for (const entity of entities) {
        lines.push(`| ${entity.index} | ${entity.name} |`)
      }
      lines.push('')

      if (schema) {
        lines.push('## Schema')
        lines.push('')
        lines.push('```mermaid')
        lines.push(schema)
        lines.push('```')
        lines.push('')
      }

      const body = lines.join('\n')
      const fullDoc = matter.stringify(body, {})

      // Write as a new file (overwrite if exists)
      const fs = await import('node:fs/promises')
      await fs.writeFile(filePath, fullDoc, 'utf-8')
    },
    async close(_ctx: TargetContext): Promise<void> {
      // Nothing to close — each write creates its own file
    },
  }
}

/**
 * Schema Document Source — reads a single schema-doc file and yields
 * its parsed content.
 */
export function createSchemaDocSource(uri: ParsedUri): Source<SchemaDocEnvelope> {
  const filePath = uri.path || uri.host

  return {
    uri: uri.raw,
    lifestyle: 'resumable',
    async *start(_ctx: SourceContext): AsyncIterable<Envelope<SchemaDocEnvelope>> {
      const text = await readFile(filePath, 'utf-8')
      const doc = parseSchemaDoc(text)
      yield { item: doc, meta: {} }
    },
    async *resume(
      _ctx: SourceContext,
      _cursor: unknown,
    ): AsyncIterable<Envelope<SchemaDocEnvelope>> {
      const text = await readFile(filePath, 'utf-8')
      const doc = parseSchemaDoc(text)
      yield { item: doc, meta: {} }
    },
  }
}

// -- Internal helpers --------------------------------------------------------

interface MdastPhrasable {
  type?: string
  value?: string
  children?: MdastPhrasable[]
}

interface MdastTable {
  type: 'table'
  children: MdastTableRow[]
}

interface MdastTableRow {
  type: string
  children: MdastPhrasable[]
}

function parseSchemaDoc(text: string): SchemaDocEnvelope {
  const { data: frontmatter, content } = matter(text)
  const tree = unified().use(remarkParse).parse(content)

  let title = ''
  let summary = ''
  const entities: { index: number; name: string }[] = []
  let schema: string | undefined

  let currentSection = ''
  const children = tree.children

  for (let i = 0; i < children.length; i++) {
    const node = children[i] as any

    if (node.type === 'heading') {
      const headingText = extractTextContent(node as MdastPhrasable)
      const depth = node.depth as number

      if (depth === 1) {
        title = headingText
        currentSection = ''
      } else if (depth === 2) {
        currentSection = headingText.toLowerCase()
      }
      continue
    }

    if (currentSection === 'summary') {
      if (node.type === 'paragraph') {
        const text = extractTextContent(node as MdastPhrasable)
        summary += (summary ? '\n\n' : '') + text
      }
    } else if (currentSection === 'entities') {
      if (node.type === 'table') {
        const tableNode = node as unknown as MdastTable
        for (let rowIdx = 1; rowIdx < tableNode.children.length; rowIdx++) {
          const row = tableNode.children[rowIdx]
          if (!row) continue
          const cell0 = row.children[0]
          const cell1 = row.children[1]
          if (cell0 && cell1) {
            const indexText = extractTextContent(cell0)
            const nameText = extractTextContent(cell1)
            const index = Number.parseInt(indexText, 10)
            if (!Number.isNaN(index)) {
              entities.push({ index, name: nameText })
            }
          }
        }
      }
    } else if (currentSection === 'schema') {
      if (node.type === 'code') {
        schema = (node as { value: string }).value
      }
    }
  }

  return {
    title,
    summary: summary.trim(),
    entities,
    schema,
    frontmatter: frontmatter as Record<string, unknown>,
  }
}

function extractTextContent(node: MdastPhrasable): string {
  if (node.value !== undefined) return node.value
  if (node.children) {
    return node.children.map((child) => extractTextContent(child)).join('')
  }
  return ''
}

// Register built-in Schema Document source and target
registry.registerSource('schema-doc', createSchemaDocSource)
registry.registerTarget('schema-doc', createSchemaDocTarget)
