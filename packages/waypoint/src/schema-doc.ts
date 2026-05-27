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
import { resolveWaypointPath } from './settings.js'

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

/**
 * Schema Document Target — writes per-chapter schema documents.
 * URI path is the output directory base (e.g. 'schema-doc://./chapters/schema').
 * Each envelope is written to: <dir>/chapter<chapterNum>.schema.md
 * Content is assembled from meta fields (title from item, summary/entities/schema from meta).
 */
export function createSchemaDocTarget(uri: ParsedUri): Target<string> {
  let baseDir = ''

  return {
    uri: uri.raw,
    async open(ctx: TargetContext): Promise<void> {
      baseDir = resolveWaypointPath(uri, 'schema-doc', ctx.run.global.settings)
      mkdirSync(baseDir, { recursive: true })
    },
    async write(env: Envelope<string>, _ctx: TargetContext): Promise<void> {
      const meta = (env.meta || {}) as Record<string, unknown>
      const chapterNum = (meta.chapterNum as number) || 0
      const summary = (meta.summary as string) || ''
      const entities = (meta.entities as { index: number; name: string }[]) || []
      const schema = meta.schema as string | undefined
      const vocabulary = (meta.vocabulary as string[]) || []
      const metadata = meta.metadata as SchemaDocMetadata | undefined

      // Extract title from the markdown item
      const firstLine = (env.item as string).trim().split('\n')[0] || ''
      const title = firstLine.startsWith('# ') ? firstLine.slice(2).trim() : `Chapter ${chapterNum}`

      const filename = `chapter${chapterNum}.schema.md`
      const filePath = join(baseDir, filename)
      mkdirSync(dirname(filePath), { recursive: true })

      const metaTable = metadata ?? {
        chapter: chapterNum,
        wordCount: (meta.wordCount as number) || 0,
        tokenCount: (meta.tokenCount as number) || 0,
        charLength: (env.item as string).length,
      }

      const lines: string[] = []
      lines.push(`# ${title}`)
      lines.push('')
      lines.push('## Metadata')
      lines.push('')
      lines.push('| chapter | wordCount | tokenCount | charLength |')
      lines.push('|---------|-----------|------------|------------|')
      lines.push(
        `| ${metaTable.chapter} | ${metaTable.wordCount} | ${metaTable.tokenCount} | ${metaTable.charLength} |`,
      )
      lines.push('')
      lines.push('## Summary')
      lines.push('')
      lines.push(summary)
      lines.push('')

      if (entities.length > 0) {
        lines.push('## Entities')
        lines.push('')
        lines.push('```csv')
        lines.push('index,name')
        for (const entity of entities) {
          lines.push(`${entity.index},${entity.name}`)
        }
        lines.push('```')
        lines.push('')
      }

      if (vocabulary.length > 0) {
        lines.push('## Vocabulary')
        lines.push('')
        lines.push('```csv')
        lines.push('word')
        for (const word of vocabulary) {
          lines.push(word)
        }
        lines.push('```')
        lines.push('')
      }

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
  return {
    uri: uri.raw,
    lifestyle: 'resumable',
    async *start(ctx: SourceContext): AsyncIterable<Envelope<SchemaDocEnvelope>> {
      const filePath = resolveWaypointPath(uri, 'schema-doc', ctx.run.global.settings)
      const text = await readFile(filePath, 'utf-8')
      const doc = parseSchemaDoc(text)
      yield { item: doc, meta: {} }
    },
    async *resume(
      ctx: SourceContext,
      _cursor: unknown,
    ): AsyncIterable<Envelope<SchemaDocEnvelope>> {
      const filePath = resolveWaypointPath(uri, 'schema-doc', ctx.run.global.settings)
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
  const vocabulary: string[] = []
  let schema: string | undefined
  let metadata: SchemaDocMetadata | undefined

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
    } else if (currentSection === 'metadata') {
      if (node.type === 'table') {
        const tableNode = node as unknown as MdastTable
        for (let rowIdx = 1; rowIdx < tableNode.children.length; rowIdx++) {
          const row = tableNode.children[rowIdx]
          if (!row) continue
          const cells = row.children.map((c) => extractTextContent(c as MdastPhrasable))
          if (cells.length >= 4) {
            const chapterCell = cells[0]
            const wordCountCell = cells[1]
            const tokenCountCell = cells[2]
            const charLengthCell = cells[3]
            if (chapterCell && wordCountCell && tokenCountCell && charLengthCell) {
              metadata = {
                chapter: Number.parseInt(chapterCell, 10) || 0,
                wordCount: Number.parseInt(wordCountCell, 10) || 0,
                tokenCount: Number.parseInt(tokenCountCell, 10) || 0,
                charLength: Number.parseInt(charLengthCell, 10) || 0,
              }
            }
          }
        }
      }
    } else if (currentSection === 'entities') {
      if (node.type === 'code' && node.lang === 'csv') {
        const csvText = (node as { value: string }).value
        const rows = csvText.trim().split('\n')
        for (let r = 1; r < rows.length; r++) {
          const row = rows[r]
          if (!row) continue
          const cols = row.split(',')
          if (cols.length >= 2) {
            const idxCell = cols[0]
            const nameCell = cols[1]
            if (idxCell && nameCell) {
              const idx = Number.parseInt(idxCell.trim(), 10)
              if (!Number.isNaN(idx)) {
                entities.push({ index: idx, name: nameCell.trim() })
              }
            }
          }
        }
      }
    } else if (currentSection === 'vocabulary') {
      if (node.type === 'code' && node.lang === 'csv') {
        const csvText = (node as { value: string }).value
        const rows = csvText.trim().split('\n')
        for (let r = 1; r < rows.length; r++) {
          const row = rows[r]
          if (!row) continue
          const word = row.trim()
          if (word) vocabulary.push(word)
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
    metadata: metadata ?? { chapter: 0, wordCount: 0, tokenCount: 0, charLength: 0 },
    summary: summary.trim(),
    entities,
    vocabulary,
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
