import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkStringify from 'remark-stringify'
import remarkGfm from 'remark-gfm'
import remarkFrontmatter from 'remark-frontmatter'

import { defineTool } from '@mt/core'
import type { Envelope, ToolContext } from '@mt/core'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface FormatOptions {
  /** Line width in characters (clamped to 80–120). Default: 100. */
  width?: number
  /** Prose wrapping mode. Default: 'always'. */
  wrapMode?: 'always' | 'preserve' | 'never'
  /** Ordered list numbering style. Default: 'ascending'. */
  orderedList?: 'ascending' | 'one'
  /** Glob/directory patterns to exclude. Default: ['node_modules', '.git', 'dist', 'build']. */
  excludes?: string[]
}

export interface FormatResult {
  /** The formatted markdown string. */
  formatted: string
  /** Whether the input was already formatted. */
  alreadyFormatted: boolean
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
  wrapMode: 'always',
  orderedList: 'ascending',
  excludes: ['node_modules', '.git', 'dist', 'build'],
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
  }
}

function buildStringifyOptions(options: Required<FormatOptions>) {
  return {
    width: options.width,
    wrap: options.wrapMode,
    bulletOrdered: options.orderedList === 'one' ? ')' : '.',
    incrementListMarker: true,
  }
}

// ---------------------------------------------------------------------------
// Remark processor helpers
// ---------------------------------------------------------------------------

/**
 * Format a markdown string using remark.
 * Uses unified + remark-parse + remark-gfm + remark-stringify.
 */
export async function formatMarkdown(
  paths: string | string[],
  _options?: FormatOptions,
  _write?: boolean,
): Promise<string | void> {
  // File-based operations not yet implemented via remark
  return
}

/**
 * Format a single markdown string using remark via stdin.
 */
export async function formatString(input: string, options?: FormatOptions): Promise<FormatResult> {
  const resolved = resolveOptions(options)
  const stringifyOpts = buildStringifyOptions(resolved)

  const processor = unified()
    .use(remarkParse)
    .use(remarkFrontmatter)
    .use(remarkGfm)
    .use(remarkStringify)

  const result = await processor.process(input)
  const formatted = String(result)
  const alreadyFormatted = formatted === input

  return {
    formatted,
    alreadyFormatted,
  }
}

// ---------------------------------------------------------------------------
// Pipeline tool — mdFormatter (defineTool wrapper)
// ---------------------------------------------------------------------------

export const mdFormatter = defineTool<string, string>({
  name: 'md-formatter',
  version: '1.0.0',
  exec: 'inproc',

  async invoke(env: Envelope<string>, _ctx: ToolContext): Promise<Envelope<string>> {
    const input = env.item as string
    const opts: FormatOptions | undefined = env.meta?.mdFormatOptions as FormatOptions | undefined

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
    } catch (_err) {
      return {
        item: input,
        meta: {
          ...env.meta,
          mdFormatted: false,
          mdFormatError: _err instanceof Error ? _err.message : String(_err),
        },
      }
    }
  },
})

export function mdFormatterTool(defaults?: FormatOptions) {
  return defineTool<string, string>({
    name: 'md-formatter',
    version: '1.0.0',
    exec: 'inproc',

    async invoke(env: Envelope<string>, _ctx: ToolContext): Promise<Envelope<string>> {
      const input = env.item as string
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
      } catch (_err) {
        return {
          item: input,
          meta: {
            ...env.meta,
            mdFormatted: false,
            mdFormatError: _err instanceof Error ? _err.message : String(_err),
          },
        }
      }
    },
  })
}
