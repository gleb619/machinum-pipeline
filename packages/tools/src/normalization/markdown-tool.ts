import { defineTool } from '@mt/core'
import type { Envelope, ToolContext } from '@mt/core'
import type { Heading, Nodes, Root, RootContent } from 'mdast'
import { toString as mdastToString } from 'mdast-util-to-string'

import { parseMarkdown } from '../normalization/remark-processor.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MarkdownStats {
  /** Number of headings, any level. */
  headings: number
  /** Top-level (`#`) heading text, if present. */
  title: string | null
  /** Number of paragraph nodes. */
  paragraphs: number
  /** Number of fenced/indented code blocks. */
  codeBlocks: number
  /** Code fence languages seen, in document order. */
  codeLanguages: string[]
  /** Number of links (`[text](url)`). */
  links: number
  /** Number of images. */
  images: number
  /** Number of GFM tables. */
  tables: number
  /** Number of list items across ordered and unordered lists. */
  listItems: number
  /** Number of blockquotes. */
  blockquotes: number
  /** Whitespace-separated word count of the body text. */
  words: number
  /** Character count of the raw markdown input. */
  characters: number
  /** True when the document opens with YAML frontmatter. */
  hasFrontmatter: boolean
}

export interface OutlineEntry {
  /** Heading depth, 1–6. */
  depth: number
  /** Heading text. */
  text: string
  /** mdast node position `start.line`, when known. */
  line: number | null
}

export interface MarkdownToolInput {
  text: string
}

export interface MarkdownStatsOutput {
  text: string
  stats: MarkdownStats
}

export interface MarkdownOutlineOutput {
  text: string
  outline: OutlineEntry[]
}

export interface MarkdownStripOutput {
  text: string
  stripped: boolean
}

// ---------------------------------------------------------------------------
// Traversal
// ---------------------------------------------------------------------------

interface Visit {
  onHeading?: (node: Heading) => void
  onCode?: (lang: string | null) => void
  onLink?: () => void
  onImage?: () => void
  onTable?: () => void
  onListItem?: () => void
  onBlockquote?: () => void
  onParagraph?: () => void
  onFrontmatter?: () => void
}

function visit(node: Nodes, handlers: Visit): void {
  if (handlers.onFrontmatter && node.type === 'yaml') handlers.onFrontmatter()

  switch (node.type) {
    case 'heading':
      handlers.onHeading?.(node)
      break
    case 'code':
      handlers.onCode?.(node.lang ?? null)
      break
    case 'link':
      handlers.onLink?.()
      break
    case 'image':
      handlers.onImage?.()
      break
    case 'table':
      handlers.onTable?.()
      break
    case 'listItem':
      handlers.onListItem?.()
      break
    case 'blockquote':
      handlers.onBlockquote?.()
      break
    case 'paragraph':
      handlers.onParagraph?.()
      break
    default:
      break
  }

  if ('children' in node && Array.isArray(node.children)) {
    for (const child of node.children as RootContent[]) visit(child, handlers)
  }
}

function walk(root: Root, handlers: Visit): void {
  visit(root, handlers)
}

// ---------------------------------------------------------------------------
// Pure helpers (exported for direct use and testing)
// ---------------------------------------------------------------------------

/** Collect structural statistics from markdown text. */
export function markdownStats(input: string): MarkdownStats {
  const tree = parseMarkdown(input)
  const stats: MarkdownStats = {
    headings: 0,
    title: null,
    paragraphs: 0,
    codeBlocks: 0,
    codeLanguages: [],
    links: 0,
    images: 0,
    tables: 0,
    listItems: 0,
    blockquotes: 0,
    words: 0,
    characters: input.length,
    hasFrontmatter: false,
  }

  walk(tree, {
    onFrontmatter: () => {
      stats.hasFrontmatter = true
    },
    onHeading: (node) => {
      stats.headings += 1
      if (node.depth === 1 && stats.title === null) stats.title = mdastToString(node)
    },
    onCode: (lang) => {
      stats.codeBlocks += 1
      if (lang) stats.codeLanguages.push(lang)
    },
    onLink: () => {
      stats.links += 1
    },
    onImage: () => {
      stats.images += 1
    },
    onTable: () => {
      stats.tables += 1
    },
    onListItem: () => {
      stats.listItems += 1
    },
    onBlockquote: () => {
      stats.blockquotes += 1
    },
    onParagraph: () => {
      stats.paragraphs += 1
    },
  })

  const body = tree.children
    .filter((node) => node.type !== 'yaml')
    .map((node) => mdastToString(node))
    .join(' ')
  stats.words = body.split(/\s+/u).filter((word) => word.length > 0).length

  return stats
}

/** Collect a flat heading outline, in document order. */
export function markdownOutline(input: string): OutlineEntry[] {
  const outline: OutlineEntry[] = []
  walk(parseMarkdown(input), {
    onHeading: (node) => {
      outline.push({
        depth: node.depth,
        text: mdastToString(node),
        line: node.position?.start.line ?? null,
      })
    },
  })
  return outline
}

/** Remove leading YAML frontmatter. */
export function stripFrontmatter(input: string): { text: string; stripped: boolean } {
  const tree = parseMarkdown(input)
  const frontmatter = tree.children[0]
  if (frontmatter?.type !== 'yaml') return { text: input, stripped: false }

  const line = frontmatter.position?.end.line ?? 1
  const rest = input.split('\n').slice(line).join('\n')
  return { text: rest, stripped: true }
}

// ---------------------------------------------------------------------------
// Pipeline tools
// ---------------------------------------------------------------------------

export const markdownStatsTool = defineTool<string, MarkdownStatsOutput>({
  name: 'markdown-stats',
  version: '1.0.0',
  mdDescription:
    'Collects structural statistics from markdown: headings, paragraphs, code blocks, links, word count.',

  async invoke(env: Envelope<string>, _ctx: ToolContext): Promise<Envelope<MarkdownStatsOutput>> {
    return {
      item: { text: env.item, stats: markdownStats(env.item) },
      meta: { ...env.meta, markdownStats: true },
    }
  },
})

export const markdownOutlineTool = defineTool<string, MarkdownOutlineOutput>({
  name: 'markdown-outline',
  version: '1.0.0',
  mdDescription:
    'Extracts a flat heading outline from markdown, in document order with depth and line numbers.',

  async invoke(env: Envelope<string>, _ctx: ToolContext): Promise<Envelope<MarkdownOutlineOutput>> {
    return {
      item: { text: env.item, outline: markdownOutline(env.item) },
      meta: { ...env.meta, markdownOutline: true },
    }
  },
})

export const markdownStripFrontmatter = defineTool<string, MarkdownStripOutput>({
  name: 'markdown-strip-frontmatter',
  version: '1.0.0',
  mdDescription: 'Removes leading YAML frontmatter from markdown documents.',

  async invoke(env: Envelope<string>, _ctx: ToolContext): Promise<Envelope<MarkdownStripOutput>> {
    const { text, stripped } = stripFrontmatter(env.item)
    return {
      item: { text, stripped },
      meta: { ...env.meta, markdownFrontmatterStripped: stripped },
    }
  },
})
