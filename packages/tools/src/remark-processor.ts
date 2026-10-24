import { basename, join } from 'node:path'

import { isDirectory, readDirectory, readTextFile } from './fs-read.js'

import type { Nodes, Root, RootContent } from 'mdast'
import remarkFrontmatter from 'remark-frontmatter'
import remarkGfm from 'remark-gfm'
import remarkParse from 'remark-parse'
import remarkStringify from 'remark-stringify'
import type { Options as StringifyOptions } from 'remark-stringify'
import { unified } from 'unified'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Prose wrapping mode. */
export type WrapMode = 'always' | 'preserve' | 'never'

/** Ordered-list marker style. */
export type OrderedListStyle = 'ascending' | 'one'

/** Directories never walked when collecting markdown files. */
export const DEFAULT_EXCLUDES: readonly string[] = ['node_modules', '.git', 'dist', 'build']

// ---------------------------------------------------------------------------
// Prose wrapping
// ---------------------------------------------------------------------------

/**
 * remark-stringify / mdast-util-to-markdown do not implement prose wrapping —
 * their `width` and `wrap` options are inert. This transform does the wrapping:
 * it rewrites paragraph text nodes into lines no wider than `width`.
 *
 * Skips links, inline code, headings and table cells (wrapping those breaks the
 * construct). `mode: 'never'` collapses a paragraph onto one line, `'preserve'`
 * leaves the source line structure alone.
 */
export function remarkWrapProse(options: { width: number; mode: WrapMode }) {
  return function transform(tree: Root): void {
    visit(tree, options, false)
  }
}

const SKIP_TYPES = new Set(['link', 'inlineCode', 'code', 'heading', 'table', 'tableCell'])

function visit(
  node: Nodes | RootContent,
  options: { width: number; mode: WrapMode },
  inheritedSkip: boolean,
): void {
  const skip = inheritedSkip || SKIP_TYPES.has(node.type)

  if (!skip && node.type === 'text') {
    node.value = rewriteLine(node.value, options)
    return
  }

  if ('children' in node && Array.isArray(node.children)) {
    for (const child of node.children as RootContent[]) visit(child, options, skip)
  }
}

/** Collapse or chunk a single line of prose to fit the target width. */
function rewriteLine(value: string, options: { width: number; mode: WrapMode }): string {
  if (!value.trim()) return value
  if (options.mode === 'preserve') return value

  const flattened = value.replace(/\s*\n\s*/gu, ' ')
  if (options.mode === 'never') return flattened.trimEnd()

  const words = flattened.split(/\s+/u).filter((word) => word.length > 0)
  const lines: string[] = []
  let current = ''
  for (const word of words) {
    if (current === '') current = word
    else if (current.length + 1 + word.length <= options.width) current += ` ${word}`
    else {
      lines.push(current)
      current = word
    }
  }
  if (current) lines.push(current)
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// Processor
// ---------------------------------------------------------------------------

/**
 * Build a unified processor: GFM + YAML frontmatter aware, markdown -> markdown.
 * `stringifyOpts` is passed through to remark-stringify (bullet style, list markers).
 * Prose wrapping is applied by {@link remarkWrapProse} — remark-stringify ignores width.
 */
export function buildProcessor(
  stringifyOpts?: StringifyOptions,
  wrap?: { width: number; mode: WrapMode },
) {
  let processor = unified().use(remarkParse).use(remarkFrontmatter).use(remarkGfm)
  if (wrap) processor = processor.use(remarkWrapProse, wrap)
  return stringifyOpts
    ? processor.use(remarkStringify, stringifyOpts)
    : processor.use(remarkStringify)
}

/** Parse markdown into an mdast tree. No stringify plugin attached. */
export function parseMarkdown(input: string): Root {
  return unified().use(remarkParse).use(remarkFrontmatter).use(remarkGfm).parse(input) as Root
}

// ---------------------------------------------------------------------------
// Filesystem helpers
// ---------------------------------------------------------------------------

export { atomicWriteFile } from './fs-write.js'

/**
 * Expand file and directory paths into a sorted list of `.md` files.
 * Directory entries matching `excludes` are skipped.
 */
export async function collectMarkdownFiles(
  paths: string | string[],
  excludes: readonly string[] = DEFAULT_EXCLUDES,
): Promise<string[]> {
  const roots = Array.isArray(paths) ? paths : [paths]
  const found: string[] = []

  const walk = async (path: string): Promise<void> => {
    if (await isDirectory(path)) {
      const entries = await readDirectory(path)
      for (const entry of entries) {
        if (excludes.includes(entry.name)) continue
        await walk(join(path, entry.name))
      }
      return
    }
    if (basename(path).endsWith('.md')) found.push(path)
  }

  for (const path of roots) await walk(path)

  return found.sort()
}

/** Read a markdown file as utf-8. */
export function readMarkdownFile(path: string): Promise<string> {
  return readTextFile(path)
}
