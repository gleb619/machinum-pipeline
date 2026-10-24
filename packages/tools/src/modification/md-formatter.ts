import { defineTool } from '@mt/core'
import type { Envelope, ToolContext } from '@mt/core'
import type { Options as StringifyOptions } from 'remark-stringify'

import {
  DEFAULT_EXCLUDES,
  type OrderedListStyle,
  type WrapMode,
  atomicWriteFile,
  buildProcessor,
  collectMarkdownFiles,
  readMarkdownFile,
} from '../normalization/remark-processor.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface FormatOptions {
  /** Line width in characters (clamped to 80–120). Default: 100. */
  width?: number
  /**
   * Prose wrapping mode. Default: 'preserve'.
   * - 'preserve' keeps the source line breaks (safe default, non-destructive)
   * - 'always' rewraps paragraphs to `width`, collapsing existing breaks
   * - 'never' joins each paragraph onto a single line
   */
  wrapMode?: WrapMode
  /** Ordered list numbering style. Default: 'ascending'. */
  orderedList?: OrderedListStyle
  /** Glob/directory patterns to exclude. Default: ['node_modules', '.git', 'dist', 'build']. */
  excludes?: string[]
}

export interface FormatResult {
  /** The formatted markdown string. */
  formatted: string
  /** Whether the input was already formatted. */
  alreadyFormatted: boolean
}

export interface FormattedFile extends FormatResult {
  /** Source path the content came from. */
  path: string
  /** True when the file was rewritten (write=true and content changed). */
  written: boolean
}

export interface MdFormatterInput {
  text: string
  options?: FormatOptions
}

export interface MdFormatterOutput {
  text: string
  formatted: boolean
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_OPTIONS: Required<FormatOptions> = {
  width: 100,
  wrapMode: 'preserve',
  orderedList: 'ascending',
  excludes: [...DEFAULT_EXCLUDES],
}

const WIDTH_MIN = 80
const WIDTH_MAX = 120

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function clampWidth(w: number): number {
  if (w < WIDTH_MIN) return WIDTH_MIN
  if (w > WIDTH_MAX) return WIDTH_MAX
  return Math.round(w)
}

function resolveOptions(opts?: FormatOptions): Required<FormatOptions> {
  return {
    ...DEFAULT_OPTIONS,
    ...opts,
    width: clampWidth(opts?.width ?? DEFAULT_OPTIONS.width),
    excludes: opts?.excludes ?? [...DEFAULT_EXCLUDES],
  }
}

function buildStringifyOptions(options: Required<FormatOptions>): StringifyOptions {
  return {
    bulletOrdered: options.orderedList === 'one' ? ')' : '.',
    incrementListMarker: true,
  }
}

// ---------------------------------------------------------------------------
// Public formatting API
// ---------------------------------------------------------------------------

/**
 * Format a markdown string using remark (GFM + frontmatter aware).
 * Idempotent: formatting an already-formatted string returns it unchanged.
 */
export async function formatString(input: string, options?: FormatOptions): Promise<FormatResult> {
  const resolved = resolveOptions(options)
  const processor = buildProcessor(buildStringifyOptions(resolved), {
    width: resolved.width,
    mode: resolved.wrapMode,
  })

  const result = await processor.process(input)
  const formatted = String(result)

  return { formatted, alreadyFormatted: formatted === input }
}

/**
 * Format markdown files on disk. Directories are walked, `excludes` are skipped.
 * With `write=true` changed files are rewritten atomically (temp + rename);
 * unchanged files are left untouched.
 */
export async function formatMarkdown(
  paths: string | string[],
  options?: FormatOptions,
  write = false,
): Promise<FormattedFile[]> {
  const resolved = resolveOptions(options)
  const files = await collectMarkdownFiles(paths, resolved.excludes)

  const results: FormattedFile[] = []
  for (const path of files) {
    const input = await readMarkdownFile(path)
    const { formatted, alreadyFormatted } = await formatString(input, options)
    const willWrite = write && !alreadyFormatted
    if (willWrite) await atomicWriteFile(path, formatted)
    results.push({ path, formatted, alreadyFormatted, written: willWrite })
  }

  return results
}

// ---------------------------------------------------------------------------
// Pipeline tool
// ---------------------------------------------------------------------------

function makeMdFormatter(defaults?: FormatOptions) {
  return defineTool<string, string>({
    name: 'md-formatter',
    version: '1.0.0',
    mdDescription:
      'Reformats markdown with configurable line width and wrapping. Uses remark (GFM + frontmatter aware).',

    async invoke(env: Envelope<string>, _ctx: ToolContext): Promise<Envelope<string>> {
      const input = env.item
      const perEnvOpts = env.meta?.mdFormatOptions as FormatOptions | undefined
      const opts: FormatOptions = { ...defaults, ...perEnvOpts }

      try {
        const result = await formatString(input, opts)

        return {
          item: result.formatted,
          meta: {
            ...env.meta,
            mdFormatted: true,
            mdAlreadyFormatted: result.alreadyFormatted,
          },
        }
      } catch (err) {
        return {
          item: input,
          meta: {
            ...env.meta,
            mdFormatted: false,
            mdFormatError: err instanceof Error ? err.message : String(err),
          },
        }
      }
    },
  })
}

/** Markdown formatter tool with no option defaults (options come from `meta.mdFormatOptions`). */
export const mdFormatter = makeMdFormatter()

/** Markdown formatter tool pre-seeded with default options. */
export function mdFormatterTool(defaults?: FormatOptions) {
  return makeMdFormatter(defaults)
}
