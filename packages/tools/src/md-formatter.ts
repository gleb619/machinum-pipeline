import { spawn } from 'node:child_process'
import { stat as fsStat, readFile, readdir } from 'node:fs/promises'
import path from 'node:path'

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
  /** The formatted markdown string (when write=false). */
  formatted: string
  /** Whether the input was already formatted (when write=false, read mode). */
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

/**
 * Clamp width to the allowed range [80, 120].
 */
function clampWidth(w: number): number {
  if (w < WIDTH_MIN) return WIDTH_MIN
  if (w > WIDTH_MAX) return WIDTH_MAX
  return Math.round(w)
}

/**
 * Resolve options against defaults.
 */
function resolveOptions(opts?: FormatOptions): Required<FormatOptions> {
  return {
    ...DEFAULT_OPTIONS,
    ...opts,
    width: clampWidth(opts?.width ?? DEFAULT_OPTIONS.width),
  }
}

/**
 * Build the mdfmt CLI argument list from resolved options and paths.
 */
function buildArgs(
  paths: string | string[],
  options: Required<FormatOptions>,
  write: boolean,
): string[] {
  const args: string[] = []

  args.push('--width', String(options.width))
  args.push('--wrap', options.wrapMode)
  args.push('--ordered-list', options.orderedList)

  if (write) {
    args.push('--write')
  }

  for (const exclude of options.excludes) {
    args.push('--exclude', exclude)
  }

  const pathList = Array.isArray(paths) ? paths : [paths]
  args.push(...pathList)

  return args
}

/**
 * Resolve mdfmt binary path.
 * Checks node_modules/.bin first, then falls back to npx.
 */
function resolveBinary(): string {
  // Try local node_modules/.bin/mdfmt first
  const localBin = path.resolve(process.cwd(), 'node_modules', '.bin', 'mdfmt')
  return localBin
}

// ---------------------------------------------------------------------------
// spawnMdfmt — low-level child process wrapper
// ---------------------------------------------------------------------------

interface SpawnResult {
  stdout: string
  stderr: string
  exitCode: number | null
}

function spawnMdfmt(args: string[], input?: string): Promise<SpawnResult> {
  return new Promise((resolve, reject) => {
    const bin = resolveBinary()
    const child = spawn(bin, args, {
      stdio: input !== undefined ? ['pipe', 'pipe', 'pipe'] : ['ignore', 'pipe', 'pipe'],
      shell: false,
    })

    let stdout = ''
    let stderr = ''

    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString()
    })

    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString()
    })

    child.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') {
        reject(
          new Error(`mdfmt binary not found at ${bin}. Ensure @rewdy/md-formatter is installed.`),
        )
      } else {
        reject(new Error(`Failed to spawn mdfmt: ${err.message}`))
      }
    })

    child.on('close', (code: number | null) => {
      resolve({ stdout, stderr, exitCode: code })
    })

    if (input !== undefined && child.stdin) {
      child.stdin.write(input)
      child.stdin.end()
    }
  })
}

// ---------------------------------------------------------------------------
// formatMarkdown — public API
// ---------------------------------------------------------------------------

/**
 * Format markdown content using the `mdfmt` binary.
 *
 * @param paths  File path(s), directory path(s), or glob patterns. Use `-` for stdin.
 * @param options  Formatting configuration.
 * @param write  If true, modify files in-place. If false, return the formatted string.
 * @returns  When write=false: the formatted markdown string.
 *           When write=true: void (files modified in-place).
 * @throws  If the mdfmt binary fails, the rejection includes stderr output.
 */
export async function formatMarkdown(
  paths: string | string[],
  options?: FormatOptions,
  write?: boolean,
): Promise<string | void> {
  const resolved = resolveOptions(options)
  const shouldWrite = write ?? false

  if (shouldWrite) {
    // In-place mode: use --write
    const args = buildArgs(paths, resolved, true)

    // Filter to only .md files if a directory is given
    const expandedPaths = await expandDirectories(paths)
    const finalArgs = buildArgs(expandedPaths, resolved, true)

    const result = await spawnMdfmt(finalArgs)

    if (result.exitCode !== 0) {
      throw new Error(`mdfmt failed with exit code ${result.exitCode}: ${result.stderr}`)
    }

    return
  }

  // Read mode: collect file contents, pipe through stdin
  const pathList = Array.isArray(paths) ? paths : [paths]

  if (pathList.length === 1 && pathList[0] === '-') {
    // Stdin mode — caller provides input
    throw new Error(
      'stdin mode (-) requires input to be piped. Use formatString() for programmatic formatting.',
    )
  }

  // Collect all markdown file contents
  const contents = await collectMarkdownContents(pathList)

  if (contents.length === 0) {
    return ''
  }

  // Format each file's content via stdin pipe
  const results: string[] = []
  for (const { filePath: _fp, content } of contents) {
    const result = await spawnMdfmt(
      [
        '--width',
        String(resolved.width),
        '--wrap',
        resolved.wrapMode,
        '--ordered-list',
        resolved.orderedList,
        '-',
      ],
      content,
    )

    if (result.exitCode !== 0) {
      throw new Error(
        `mdfmt failed for stdin input with exit code ${result.exitCode}: ${result.stderr}`,
      )
    }

    results.push(result.stdout)
  }

  return results.join('\n---\n\n')
}

/**
 * Format a single markdown string using mdfmt via stdin.
 * This is the programmatic equivalent of `echo "$md" | mdfmt -`.
 */
export async function formatString(input: string, options?: FormatOptions): Promise<FormatResult> {
  const resolved = resolveOptions(options)

  const result = await spawnMdfmt(
    [
      '--width',
      String(resolved.width),
      '--wrap',
      resolved.wrapMode,
      '--ordered-list',
      resolved.orderedList,
      '-',
    ],
    input,
  )

  if (result.exitCode !== 0) {
    throw new Error(`mdfmt failed with exit code ${result.exitCode}: ${result.stderr}`)
  }

  const alreadyFormatted = result.stdout === input

  return {
    formatted: result.stdout,
    alreadyFormatted,
  }
}

// ---------------------------------------------------------------------------
// File system helpers
// ---------------------------------------------------------------------------

/**
 * Expand directory paths to their contained *.md files.
 * Non-directory entries pass through unchanged.
 */
async function expandDirectories(paths: string | string[]): Promise<string[]> {
  const pathList = Array.isArray(paths) ? paths : [paths]
  const result: string[] = []

  for (const p of pathList) {
    try {
      const st = await fsStat(p)
      if (st.isDirectory()) {
        const dirents = await readdir(p, { withFileTypes: true })
        for (const d of dirents) {
          if (d.isFile() && d.name.endsWith('.md')) {
            result.push(path.join(p, d.name))
          }
        }
      } else {
        result.push(p)
      }
    } catch {
      // Path doesn't exist or can't be stat'd — treat as literal
      result.push(p)
    }
  }

  return result
}

interface ContentEntry {
  filePath: string
  content: string
}

/**
 * Collect markdown file contents from a list of paths.
 * Directory paths are expanded to contained *.md files.
 * Non-.md files are skipped.
 */
async function collectMarkdownContents(paths: string[]): Promise<ContentEntry[]> {
  const entries: ContentEntry[] = []

  for (const p of paths) {
    try {
      const st = await fsStat(p)

      if (st.isDirectory()) {
        const mdFiles: string[] = []
        const dirents = await readdir(p, { withFileTypes: true })
        for (const d of dirents) {
          if (d.isFile() && d.name.endsWith('.md')) {
            mdFiles.push(path.join(p, d.name))
          }
        }
        for (const md of mdFiles.sort()) {
          try {
            const content = await readFile(md, 'utf-8')
            entries.push({ filePath: md, content })
          } catch {
            // Skip files that can't be read
          }
        }
      } else if (st.isFile() && p.endsWith('.md')) {
        const content = await readFile(p, 'utf-8')
        entries.push({ filePath: p, content })
      }
      // Non-.md files are skipped gracefully
    } catch {
      // Path doesn't exist — skip
    }
  }

  return entries
}

// ---------------------------------------------------------------------------
// Pipeline tool — mdFormatter (defineTool wrapper)
// ---------------------------------------------------------------------------

/**
 * Pipeline-compatible tool that formats markdown text in an envelope.
 *
 * Usage in a pipeline:
 * ```ts
 * .use(mdFormatter)
 * // or with options:
 * .use(mdFormatterTool({ width: 100, wrapMode: 'always' }))
 * ```
 */
export const mdFormatter = defineTool<string, string>({
  name: 'md-formatter',
  version: '1.0.0',
  exec: 'inproc', // Spawns child process internally

  async invoke(env: Envelope<string>, _ctx: ToolContext): Promise<Envelope<string>> {
    const input = env.item as string

    // Extract format options from meta if provided
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
      // If formatting fails (e.g., binary not available), return input unchanged
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

/**
 * Factory: create a pre-configured mdFormatter tool with default options.
 * Options passed here become the defaults; they can be overridden per-envelope
 * via env.meta.mdFormatOptions.
 */
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
