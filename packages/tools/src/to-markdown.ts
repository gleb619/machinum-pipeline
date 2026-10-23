import { defineTool } from '@mt/core'
import type { Envelope, ToolContext } from '@mt/core'
import type { Heading, Paragraph, Root, RootContent, Text } from 'mdast'
import { remark } from 'remark'
import remarkFrontmatter from 'remark-frontmatter'
import remarkGfm from 'remark-gfm'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ToMarkdownInput {
  /** Optional top-level heading. */
  title?: string
  /** Body text; blank-line blocks become paragraphs. */
  body: string
}

// ---------------------------------------------------------------------------
// mdast helpers
// ---------------------------------------------------------------------------

function text(value: string): Text {
  return { type: 'text', value }
}

function heading1(title: string): Heading {
  return { type: 'heading', depth: 1, children: [text(title)] }
}

function paragraph(body: string): Paragraph {
  return { type: 'paragraph', children: [text(body)] }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Build a markdown document from a structured record using remark. */
export function recordToMarkdown(input: ToMarkdownInput): string {
  const children: RootContent[] = []

  const title = input.title?.trim()
  if (title) children.push(heading1(title))

  for (const block of input.body.split(/\n\s*\n/)) {
    const trimmed = block.trim()
    if (!trimmed) continue
    children.push(paragraph(trimmed))
  }

  const tree: Root = { type: 'root', children }
  const processor = remark().use(remarkGfm).use(remarkFrontmatter)
  return processor.stringify(tree)
}

// ---------------------------------------------------------------------------
// Pipeline tool
// ---------------------------------------------------------------------------

export const toMarkdown = defineTool<ToMarkdownInput, string>({
  name: 'to-markdown',
  version: '1.0.0',
  exec: 'inproc',

  async invoke(env: Envelope<ToMarkdownInput>, _ctx: ToolContext): Promise<Envelope<string>> {
    const item = env.item
    const input: ToMarkdownInput =
      typeof item === 'string' ? { body: item } : { title: item.title, body: item.body }

    const markdown = recordToMarkdown(input)

    return {
      item: markdown,
      meta: {
        ...env.meta,
        toMarkdown: true,
      },
    }
  },
})

export { toMarkdown as toMarkdownTool }
